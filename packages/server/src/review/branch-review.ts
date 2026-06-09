import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Platform, ReviewEngineKind } from "../domain/entities.js";
import type {
  CheckConclusion,
  DiffFile,
  DiffFileStatus,
} from "../providers/git-provider.js";
import type { CommandRunner } from "./command-runner.js";
import { filterToChangedLines } from "./diff-lines.js";
import type { FindingDraft, ReviewContext, ReviewEngine } from "./review-engine.js";
import { scanStructure } from "./structure-scanner.js";

/** Self-contained "review the diff between two branches" task (no PR). */
export interface BranchTaskInput {
  platform: Platform;
  repoFullName: string;
  /** Clone URL (may embed credentials for private repos). */
  cloneUrl: string;
  headBranch: string;
  baseBranch: string;
  /** Engine override; falls back to the service default. */
  engine?: ReviewEngineKind;
}

export interface BranchReviewResult {
  findings: FindingDraft[];
  conclusion: CheckConclusion;
}

export interface BranchReviewDeps {
  git: CommandRunner;
  /** Build an engine for a kind (bound to config/engineDeps by the caller). */
  createEngine: (kind: ReviewEngineKind) => ReviewEngine;
  defaultEngine: ReviewEngineKind;
  enabledEngines: ReviewEngineKind[];
  /** Structure scanner; defaults to the filesystem walker. */
  scan?: (dir: string) => Promise<string[]>;
  /** Root under which per-task working copies are created. */
  workspaceRoot?: string;
  /** Keep only findings on changed lines (noise reduction). */
  onlyChangedLines?: boolean;
}

/**
 * Reviews the diff between two branches without any PR. Clones the repo,
 * computes `git diff base...head` into the same {@link DiffFile} shape the
 * providers produce, builds a whole-repo context at the head branch, and runs
 * the configured engine. Pure produce step — delivery (callback) is the
 * caller's job. Git commands go through an injected {@link CommandRunner} so
 * the logic is unit-testable without a real clone (like {@link GitCloner}).
 */
export class BranchReviewService {
  constructor(private readonly deps: BranchReviewDeps) {}

  async review(task: BranchTaskInput): Promise<BranchReviewResult> {
    const kind = task.engine ?? this.deps.defaultEngine;
    if (!this.deps.enabledEngines.includes(kind)) {
      throw new Error(
        `Engine '${kind}' is not enabled. Enabled: ${this.deps.enabledEngines.join(", ")}.`,
      );
    }
    const engine = this.deps.createEngine(kind);

    const root = this.deps.workspaceRoot ?? tmpdir();
    // Ensure the workspace root exists; recursive is idempotent under
    // concurrency, and each task gets its own unique mkdtemp subdir below.
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(join(root, "reviewpilot-branch-"));
    try {
      await this.run(["clone", task.cloneUrl, dir]);
      // Make the workspace reflect the head branch for whole-repo context.
      await this.run(["-C", dir, "checkout", task.headBranch]);

      const range = `origin/${task.baseBranch}...origin/${task.headBranch}`;
      const headSha = (await this.run(["-C", dir, "rev-parse", `origin/${task.headBranch}`])).stdout.trim();
      const diff = await this.collectDiff(dir, range);

      const scan = this.deps.scan ?? scanStructure;
      const structure = await scan(dir);

      const context: ReviewContext = {
        platform: task.platform,
        repoFullName: task.repoFullName,
        pullRequest: {
          number: 0,
          title: `${task.headBranch} → ${task.baseBranch}`,
          sourceBranch: task.headBranch,
          targetBranch: task.baseBranch,
          headSha,
          author: "",
          url: "",
        },
        structure,
        diff,
        workspaceDir: dir,
      };

      const produced = await engine.review(context);
      const findings = this.deps.onlyChangedLines
        ? filterToChangedLines(produced, diff)
        : produced;
      return { findings, conclusion: findings.length ? "neutral" : "success" };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Run a git command, throwing with stderr on a non-zero exit. */
  private async run(args: string[]): Promise<{ stdout: string }> {
    const res = await this.deps.git.run("git", args);
    if (res.code !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${res.stderr.trim()}`);
    }
    return { stdout: res.stdout };
  }

  /** Build {@link DiffFile}[] from `git diff` over a commit range. */
  private async collectDiff(dir: string, range: string): Promise<DiffFile[]> {
    const nameStatus = (await this.run(["-C", dir, "diff", "--name-status", range])).stdout;
    const files: DiffFile[] = [];
    for (const line of nameStatus.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      const code = parts[0] ?? "";
      const status = mapStatus(code);
      // Renames carry old + new path; use the new path as the file.
      const path = (status === "renamed" ? parts[2] : parts[1]) ?? "";
      if (!path) continue;
      const previousPath = status === "renamed" ? parts[1] : undefined;
      const patch = (await this.run(["-C", dir, "diff", range, "--", path])).stdout;
      files.push({
        path,
        status,
        ...(previousPath ? { previousPath } : {}),
        ...(patch ? { patch } : {}),
      });
    }
    return files;
  }
}

function mapStatus(code: string): DiffFileStatus {
  const c = code[0];
  if (c === "A") return "added";
  if (c === "D") return "removed";
  if (c === "R") return "renamed";
  return "modified";
}
