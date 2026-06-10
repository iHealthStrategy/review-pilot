import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Platform, ReviewEngineKind } from "../domain/entities.js";
import type { DiffFile, DiffFileStatus } from "../providers/git-provider.js";
import type { CommandRunner } from "../review/command-runner.js";
import { cloneWithRetry } from "../review/git-clone.js";
import { filterToChangedLines } from "../review/diff-lines.js";
import type { FindingDraft, ReviewContext, ReviewEngine } from "../review/review-engine.js";
import { scanStructure } from "../review/structure-scanner.js";
import type { ScheduleConfig } from "./schedule.js";
import { tzDate } from "./tz.js";

/** Per-branch outcome of a daily scan. */
export interface BranchScanResult {
  branch: string;
  commitCount: number;
  findings: FindingDraft[];
}

/** Aggregate result of scanning one schedule config. */
export interface ScanResult {
  repoFullName: string;
  /** Local date (YYYY-MM-DD in the config timezone) the scan covered. */
  date: string;
  branches: BranchScanResult[];
  totalFindings: number;
}

export interface ScanServiceDeps {
  git: CommandRunner;
  createEngine: (kind: ReviewEngineKind) => ReviewEngine;
  defaultEngine: ReviewEngineKind;
  enabledEngines: ReviewEngineKind[];
  scan?: (dir: string) => Promise<string[]>;
  workspaceRoot?: string;
  onlyChangedLines?: boolean;
  /**
   * Resolve an authenticated clone URL via the platform provider (injects a
   * token + honours any host override), so PRIVATE repos can be cloned — the
   * same resolution the PR pipeline uses. Falls back to the schedule's stored
   * cloneUrl when omitted.
   */
  resolveCloneUrl?: (platform: Platform, repoFullName: string) => Promise<string>;
}

/**
 * Reviews a day's worth of changes on a repository's branches. For each target
 * branch it gathers the commits authored "today" (in the schedule's timezone),
 * builds the aggregate diff from the parent of the earliest such commit to the
 * branch tip, and runs the engine over it — one review per branch (the chosen
 * granularity). Git runs through an injected {@link CommandRunner}, so the
 * logic is unit-testable without a real clone.
 */
export class ScheduledScanService {
  constructor(private readonly deps: ScanServiceDeps) {}

  async scan(config: ScheduleConfig, now: Date = new Date()): Promise<ScanResult> {
    const kind = config.engine ?? this.deps.defaultEngine;
    if (!this.deps.enabledEngines.includes(kind)) {
      throw new Error(
        `Engine '${kind}' is not enabled. Enabled: ${this.deps.enabledEngines.join(", ")}.`,
      );
    }
    const engine = this.deps.createEngine(kind);
    const tz = config.timezone || "UTC";
    const date = tzDate(tz, now);
    const since = `${date} 00:00:00`;

    const root = this.deps.workspaceRoot ?? tmpdir();
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(join(root, "reviewpilot-scan-"));
    try {
      // Prefer a provider-resolved (token-injected) URL so private repos clone;
      // fall back to the stored URL. Clone WITHOUT `-C dir` (cloning into the
      // cwd confuses git); subsequent commands run inside the repo via `-C dir`.
      // Retries ride out transient repo-host egress blips.
      const cloneUrl = this.deps.resolveCloneUrl
        ? await this.deps.resolveCloneUrl(config.platform, config.repoFullName)
        : config.cloneUrl;
      await cloneWithRetry(this.deps.git, cloneUrl, dir);

      const branches = config.branches.length
        ? config.branches
        : await this.remoteBranches(dir);

      const results: BranchScanResult[] = [];
      for (const branch of branches) {
        const commits = (await this.run(dir, [
          "log", `origin/${branch}`, `--since=${since}`, "--format=%H",
        ], tz)).stdout.split("\n").map((s) => s.trim()).filter(Boolean);
        if (commits.length === 0) continue; // no changes today on this branch

        const oldest = commits[commits.length - 1]!;
        const range = `${oldest}^..origin/${branch}`;
        const diff = await this.collectDiff(dir, range);
        if (diff.length === 0) continue;

        await this.run(dir, ["checkout", "--force", `origin/${branch}`]);
        const structure = await (this.deps.scan ?? scanStructure)(dir);
        const context = this.buildContext(config, branch, structure, diff);
        const produced = await engine.review(context);
        const findings = this.deps.onlyChangedLines
          ? filterToChangedLines(produced, diff)
          : produced;
        results.push({ branch, commitCount: commits.length, findings });
      }

      return {
        repoFullName: config.repoFullName,
        date,
        branches: results,
        totalFindings: results.reduce((n, b) => n + b.findings.length, 0),
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private buildContext(
    config: ScheduleConfig,
    branch: string,
    structure: string[],
    diff: DiffFile[],
  ): ReviewContext {
    return {
      platform: config.platform as Platform,
      repoFullName: config.repoFullName,
      pullRequest: {
        number: 0,
        title: `Daily changes on ${branch}`,
        sourceBranch: branch,
        targetBranch: branch,
        headSha: "",
        author: "",
        url: "",
      },
      structure,
      diff,
      workspaceDir: "",
    };
  }

  private async remoteBranches(dir: string): Promise<string[]> {
    const out = (await this.run(dir, [
      "branch", "-r", "--format=%(refname:short)",
    ])).stdout;
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s && !s.includes("->") && s !== "origin/HEAD")
      .map((s) => (s.startsWith("origin/") ? s.slice("origin/".length) : s))
      .filter((s) => s !== "HEAD");
  }

  private async collectDiff(dir: string, range: string): Promise<DiffFile[]> {
    const nameStatus = (await this.run(dir, ["diff", "--name-status", range])).stdout;
    const files: DiffFile[] = [];
    for (const line of nameStatus.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      const status = mapStatus(parts[0] ?? "");
      const path = (status === "renamed" ? parts[2] : parts[1]) ?? "";
      if (!path) continue;
      const previousPath = status === "renamed" ? parts[1] : undefined;
      const patch = (await this.run(dir, ["diff", range, "--", path])).stdout;
      files.push({
        path,
        status,
        ...(previousPath ? { previousPath } : {}),
        ...(patch ? { patch } : {}),
      });
    }
    return files;
  }

  /** Run a git command in `dir`; throws with stderr on non-zero exit. */
  private async run(dir: string, args: string[], tz?: string) {
    const res = await this.deps.git.run("git", ["-C", dir, ...args], {
      ...(tz ? { env: { TZ: tz } } : {}),
    });
    if (res.code !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${res.stderr.trim()}`);
    }
    return res;
  }
}

function mapStatus(code: string): DiffFileStatus {
  const c = code[0];
  if (c === "A") return "added";
  if (c === "D") return "removed";
  if (c === "R") return "renamed";
  return "modified";
}
