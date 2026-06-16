import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type CommandRunner, ProcessCommandRunner } from "./command-runner.js";
import { FileRepoLock, type RepoLock } from "./repo-lock.js";
import {
  parseStructuralJson,
  type StructuralContext,
} from "./structural-context.js";

/**
 * A per-repo, base-branch-pinned code graph shared across all reviews of that
 * repo. Maintained ONCE and refreshed on a TTL (under a cross-process lock so
 * concurrent reviews — across workers/replicas — never rebuild it at the same
 * time). Per-PR structural analysis is a READ-ONLY query against this graph,
 * so any number of concurrent PRs on the same repo run in parallel with no
 * rebuild and no write contention.
 *
 * Trade-off: the graph reflects the base branch, not each PR's head — a sound
 * approximation for risk/test-gap/impact signal (code brand-new to a PR simply
 * isn't in the graph yet). Cache is per-host-local; see {@link RepoLock}.
 */
export interface GraphCacheOptions {
  /** Root dir holding all per-repo caches. */
  cacheRoot: string;
  /** Launcher exposing `code-review-graph` on PATH (default "uvx"). */
  launcher?: string;
  /** Rebuild the base graph once it is older than this (ms). */
  ttlMs: number;
  /** Hard timeout per graph subprocess (ms). */
  timeoutMs?: number;
  commandRunner?: CommandRunner;
  lock?: RepoLock;
  now?: () => number;
  onLog?: (message: string) => void;
}

export interface BaseGraphRef {
  /** Checkout the graph was built from (its node paths live under here). */
  srcRoot: string;
  /** Graph DB location (CRG_DATA_DIR). */
  dataDir: string;
}

export interface RepoIdentity {
  platform: string;
  fullName: string;
  cloneUrl: string;
  baseBranch: string;
}

interface CacheMeta {
  baseSha: string;
  builtAt: number;
}

/** Read-only analyze_changes against an already-built graph (explicit ranges). */
const ANALYZE_PY = [
  "import json, sys",
  "from pathlib import Path",
  "from code_review_graph.graph import GraphStore",
  "from code_review_graph.incremental import get_db_path",
  "from code_review_graph.changes import analyze_changes",
  "root = Path(sys.argv[1]); payload = json.loads(sys.argv[2])",
  "try:",
  "    store = GraphStore(get_db_path(root))",
  "    files = [str(root / f) for f in payload['files']]",
  "    ranges = {str(root / k): [tuple(r) for r in v] for k, v in payload['ranges'].items()}",
  "    r = analyze_changes(store, changed_files=files, changed_ranges=ranges or None)",
  "    print(json.dumps({'status': 'ok', **r}, default=str))",
  "except Exception as e:",
  "    print(json.dumps({'status': 'error', 'message': str(e)}))",
].join("\n");

export class GraphCacheService {
  private readonly runner: CommandRunner;
  private readonly lock: RepoLock;
  private readonly launcher: string;
  private readonly now: () => number;
  private readonly log: (m: string) => void;

  constructor(private readonly options: GraphCacheOptions) {
    this.runner = options.commandRunner ?? new ProcessCommandRunner();
    this.lock = options.lock ?? new FileRepoLock({ now: options.now });
    this.launcher = options.launcher?.trim() || "uvx";
    this.now = options.now ?? Date.now;
    this.log = options.onLog ?? (() => {});
  }

  /**
   * Ensure a usable base graph for `repo` and return its location, or null when
   * none can be produced right now. Fresh → reuse immediately (no lock). Stale
   * or missing → try the per-repo lock WITHOUT blocking: the winner refreshes;
   * losers reuse an existing (stale) graph or, if none exists yet, get null and
   * skip structural context for this review.
   */
  async ensureBaseGraph(
    repo: RepoIdentity,
    expectedBaseSha?: string,
  ): Promise<BaseGraphRef | null> {
    const base = this.repoDir(repo);
    const ref: BaseGraphRef = { srcRoot: join(base, "src"), dataDir: join(base, "graph") };
    const meta = await this.readMeta(base);
    // "Servable" means a build has COMPLETED: meta.json is written only after a
    // successful build, so it — not the presence of graph.db, which can exist
    // mid-build — is the readiness gate. This is what prevents a concurrent
    // reader from querying a half-written graph during another job's first build.
    const servable = !!meta && this.graphBuilt(ref);
    // The graph is fresh only if it is also built from the CURRENT base tip.
    // The caller passes the base sha it sees (read for free from the PR's
    // already-fetched checkout), so a base advance forces a refresh well before
    // the TTL — keeping the "modify existing code" case accurate against base.
    const onCurrentBase = !expectedBaseSha || meta?.baseSha === expectedBaseSha;

    if (servable && onCurrentBase && this.now() - meta.builtAt < this.options.ttlMs) {
      return ref; // fresh — the common concurrent path, fully lock-free.
    }

    const lockPath = join(base, ".refresh.lock");
    const release = await this.lock.tryAcquire(lockPath);
    if (!release) {
      // Someone else is refreshing. Use a previously-completed graph if we have
      // one; otherwise skip structural context for this run (no blocking).
      if (servable) {
        this.log("Graph refresh in progress elsewhere; using existing graph.");
        return ref;
      }
      this.log("Graph being built elsewhere; skipping structural context this run.");
      return null;
    }
    try {
      const ok = await this.refresh(repo, ref, meta);
      return ok || servable ? ref : null;
    } finally {
      await release();
    }
  }

  /**
   * Read-only structural analysis for a change set against the base graph.
   * Concurrency-safe: opens the graph store read-only and passes PR-derived
   * ranges, so it never writes and never invokes git.
   */
  async query(
    ref: BaseGraphRef,
    changedFiles: string[],
    ranges: Map<string, Array<[number, number]>>,
  ): Promise<StructuralContext | null> {
    const payload = JSON.stringify({
      files: changedFiles,
      ranges: Object.fromEntries(ranges),
    });
    const res = await this.runner.run(
      this.launcher,
      ["--from", "code-review-graph", "python", "-c", ANALYZE_PY, ref.srcRoot, payload],
      {
        cwd: ref.srcRoot,
        env: { CRG_DATA_DIR: ref.dataDir },
        ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
      },
    );
    if (res.code !== 0) {
      this.log(`Structural query failed (skipping): ${res.stderr.trim().slice(0, 200)}`);
      return null;
    }
    return parseStructuralJson(res.stdout);
  }

  private async refresh(
    repo: RepoIdentity,
    ref: BaseGraphRef,
    prev: CacheMeta | null,
  ): Promise<boolean> {
    const env = { CRG_DATA_DIR: ref.dataDir };
    const timeout = this.options.timeoutMs;
    const t = timeout ? { timeoutMs: timeout } : {};

    // 1. Sync a base-branch checkout (clone once, then fetch).
    if (!existsSync(join(ref.srcRoot, ".git"))) {
      await mkdir(ref.srcRoot, { recursive: true });
      const cloned = await this.git(
        ["clone", "--branch", repo.baseBranch, "--single-branch", repo.cloneUrl, ref.srcRoot],
        undefined,
        timeout,
      );
      if (cloned.code !== 0) {
        this.log(`Graph cache clone failed: ${cloned.stderr.trim().slice(0, 200)}`);
        return false;
      }
    } else {
      await this.git(["-C", ref.srcRoot, "fetch", "origin", repo.baseBranch], undefined, timeout);
      await this.git(
        ["-C", ref.srcRoot, "reset", "--hard", `origin/${repo.baseBranch}`],
        undefined,
        timeout,
      );
    }

    const head = await this.git(["-C", ref.srcRoot, "rev-parse", "HEAD"], undefined, timeout);
    const newSha = head.stdout.trim();

    // 2. Parse into the graph: incremental from the last built sha when we can,
    //    else a full build. A no-op when the base hasn't moved.
    const builtBefore = this.graphBuilt(ref);
    if (builtBefore && prev?.baseSha && prev.baseSha === newSha) {
      this.log("Base graph already current; bumping freshness.");
    } else if (builtBefore && prev?.baseSha) {
      const upd = await this.runner.run(
        this.launcher,
        ["code-review-graph", "update", "--repo", ref.srcRoot, "--base", prev.baseSha],
        { cwd: ref.srcRoot, env, ...t },
      );
      if (upd.code !== 0) {
        this.log(`Graph update failed: ${upd.stderr.trim().slice(0, 200)}`);
        return builtBefore; // keep serving the old graph
      }
    } else {
      this.log("Building base graph (first time for this repo)…");
      const b = await this.runner.run(
        this.launcher,
        ["code-review-graph", "build", "--repo", ref.srcRoot],
        { cwd: ref.srcRoot, env, ...t },
      );
      if (b.code !== 0) {
        this.log(`Graph build failed: ${b.stderr.trim().slice(0, 200)}`);
        return false;
      }
    }

    await this.writeMeta(this.repoDir(repo), { baseSha: newSha, builtAt: this.now() });
    return true;
  }

  private git(args: string[], cwd: string | undefined, timeoutMs?: number) {
    return this.runner.run("git", args, {
      ...(cwd ? { cwd } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    });
  }

  private graphBuilt(ref: BaseGraphRef): boolean {
    return existsSync(join(ref.dataDir, "graph.db"));
  }

  /**
   * Filesystem-safe cache dir, keyed by repo AND base branch:
   * `<cacheRoot>/<platform>/<owner__repo>/<base-branch>`. Keying on the base
   * branch matters: PRs targeting different bases (e.g. `main` vs a release
   * branch) need DIFFERENT base graphs — sharing one dir would let a PR query a
   * graph built from the wrong branch, or thrash refreshes between bases.
   */
  private repoDir(repo: RepoIdentity): string {
    const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]+/g, "__");
    return join(
      this.options.cacheRoot,
      repo.platform,
      safe(repo.fullName),
      safe(repo.baseBranch) || "default",
    );
  }

  private async readMeta(baseDir: string): Promise<CacheMeta | null> {
    try {
      const raw = await readFile(join(baseDir, "meta.json"), "utf8");
      const m = JSON.parse(raw) as CacheMeta;
      return typeof m.builtAt === "number" ? m : null;
    } catch {
      return null;
    }
  }

  private async writeMeta(baseDir: string, meta: CacheMeta): Promise<void> {
    await mkdir(baseDir, { recursive: true });
    await writeFile(join(baseDir, "meta.json"), JSON.stringify(meta));
  }
}
