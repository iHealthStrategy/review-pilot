import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CommandResult,
  CommandRunner,
  CommandRunOptions,
} from "../src/review/command-runner.js";
import type { LockRelease, RepoLock } from "../src/review/repo-lock.js";
import { GraphCacheService } from "../src/review/graph-cache.js";

const REPO = {
  platform: "github",
  fullName: "acme/app",
  cloneUrl: "https://x/y.git",
  baseBranch: "main",
};

const ANALYZE_JSON = JSON.stringify({
  status: "ok",
  risk_score: 0.5,
  summary: "s",
  changed_functions: [],
  affected_flows: [],
  test_gaps: [{ name: "h", file: "/c/src/h.ts", line_start: 1 }],
  review_priorities: [{ name: "h", kind: "Function", file_path: "/c/src/h.ts", line_start: 1, risk_score: 0.5 }],
});

class FakeRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: string[]; opts?: CommandRunOptions }> = [];
  run(command: string, args: string[], opts?: CommandRunOptions): Promise<CommandResult> {
    this.calls.push({ command, args, ...(opts ? { opts } : {}) });
    if (args.includes("python")) return Promise.resolve({ code: 0, stdout: ANALYZE_JSON, stderr: "" });
    if (args.includes("rev-parse")) return Promise.resolve({ code: 0, stdout: "sha999\n", stderr: "" });
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  }
}

class FakeLock implements RepoLock {
  acquired = 0;
  constructor(private readonly grant: boolean) {}
  async tryAcquire(_lockPath: string): Promise<LockRelease | null> {
    this.acquired += 1;
    return this.grant ? async () => {} : null;
  }
}

async function cacheRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "rp-gcache-"));
}

function svc(root: string, runner: CommandRunner, lock: RepoLock, now = 1000): GraphCacheService {
  return new GraphCacheService({
    cacheRoot: root,
    ttlMs: 10_000,
    commandRunner: runner,
    lock,
    now: () => now,
    launcher: "uvx",
  });
}

const repoBase = (root: string) => join(root, "github", "acme__app", "main");

test("fresh graph is reused with no lock and no subprocess", async () => {
  const root = await cacheRoot();
  const base = repoBase(root);
  await mkdir(join(base, "graph"), { recursive: true });
  await writeFile(join(base, "graph", "graph.db"), "x");
  await writeFile(join(base, "meta.json"), JSON.stringify({ baseSha: "s", builtAt: 1000 }));

  const runner = new FakeRunner();
  const lock = new FakeLock(true);
  const ref = await svc(root, runner, lock, 5000).ensureBaseGraph(REPO); // age 4000 < ttl 10000

  assert.ok(ref);
  assert.equal(ref!.srcRoot, join(base, "src"));
  assert.equal(lock.acquired, 0, "fresh path must not touch the lock");
  assert.equal(runner.calls.length, 0, "fresh path must not run any subprocess");
});

test("missing graph: acquires lock, clones, builds, writes meta", async () => {
  const root = await cacheRoot();
  const runner = new FakeRunner();
  const lock = new FakeLock(true);
  const ref = await svc(root, runner, lock).ensureBaseGraph(REPO);

  assert.ok(ref);
  assert.equal(lock.acquired, 1);
  assert.ok(runner.calls.some((c) => c.command === "git" && c.args.includes("clone")));
  const build = runner.calls.find((c) => c.args.includes("build"));
  assert.ok(build, "a full build should run for a missing graph");
  assert.equal(build!.opts?.env?.CRG_DATA_DIR, join(repoBase(root), "graph"));
  // Freshness persisted.
  const meta = JSON.parse(await readFile(join(repoBase(root), "meta.json"), "utf8"));
  assert.equal(meta.baseSha, "sha999");
});

test("base advance forces a refresh even when fresh by TTL", async () => {
  const root = await cacheRoot();
  const base = repoBase(root);
  await mkdir(join(base, "graph"), { recursive: true });
  await writeFile(join(base, "graph", "graph.db"), "x");
  // Completed and within TTL, but built from an OLD base sha.
  await writeFile(join(base, "meta.json"), JSON.stringify({ baseSha: "old", builtAt: 4900 }));

  const runner = new FakeRunner();
  const lock = new FakeLock(true);
  // now=5000 (age 100 < ttl 10000) but the current base tip is "new" ≠ "old".
  const ref = await svc(root, runner, lock, 5000).ensureBaseGraph(REPO, "new");

  assert.ok(ref);
  assert.equal(lock.acquired, 1, "a base advance must take the refresh lock despite TTL freshness");
  assert.ok(runner.calls.length > 0, "refresh should run a subprocess");
});

test("lock busy but an existing graph is served stale (no rebuild)", async () => {
  const root = await cacheRoot();
  const base = repoBase(root);
  await mkdir(join(base, "graph"), { recursive: true });
  await writeFile(join(base, "graph", "graph.db"), "x");
  // A COMPLETED-but-stale build: meta present, builtAt far in the past.
  await writeFile(join(base, "meta.json"), JSON.stringify({ baseSha: "old", builtAt: 1 }));

  const runner = new FakeRunner();
  const lock = new FakeLock(false); // refresh in progress elsewhere
  // now far ahead of builtAt → stale (age >> ttl), so it takes the lock path.
  const ref = await svc(root, runner, lock, 1_000_000).ensureBaseGraph(REPO);

  assert.ok(ref, "should serve the existing (stale) graph");
  assert.equal(lock.acquired, 1);
  assert.ok(!runner.calls.some((c) => c.args.includes("build") || c.args.includes("clone")));
});

test("lock busy and no graph yet → null (review skips structural context)", async () => {
  const root = await cacheRoot();
  const ref = await svc(root, new FakeRunner(), new FakeLock(false)).ensureBaseGraph(REPO);
  assert.equal(ref, null);
});

test("a half-built graph.db (no meta yet) is NOT served while a build is in progress", async () => {
  const root = await cacheRoot();
  const base = repoBase(root);
  await mkdir(join(base, "graph"), { recursive: true });
  await writeFile(join(base, "graph", "graph.db"), "partial"); // mid-build, no meta
  // Lock is held by the builder → we must skip, not query the partial graph.
  const ref = await svc(root, new FakeRunner(), new FakeLock(false)).ensureBaseGraph(REPO);
  assert.equal(ref, null);
});

test("PRs targeting different base branches use isolated caches", async () => {
  const root = await cacheRoot();
  // A completed graph exists for `main` only.
  const mainBase = join(root, "github", "acme__app", "main");
  await mkdir(join(mainBase, "graph"), { recursive: true });
  await writeFile(join(mainBase, "graph", "graph.db"), "x");
  await writeFile(join(mainBase, "meta.json"), JSON.stringify({ baseSha: "m", builtAt: 5000 }));

  // A PR targeting `release` must NOT see main's graph; with the lock busy and
  // no release graph yet, it skips rather than querying the wrong branch.
  const ref = await svc(root, new FakeRunner(), new FakeLock(false), 5000).ensureBaseGraph({
    ...REPO,
    baseBranch: "release",
  });
  assert.equal(ref, null);
});

test("query runs read-only analyze with CRG_DATA_DIR and parses the result", async () => {
  const root = await cacheRoot();
  const runner = new FakeRunner();
  const ref = { srcRoot: "/c/src", dataDir: "/c/graph" };
  const ranges = new Map<string, Array<[number, number]>>([["src/h.ts", [[1, 1]]]]);
  const sc = await svc(root, runner, new FakeLock(true)).query(ref, ["src/h.ts"], ranges);

  assert.ok(sc);
  assert.equal(sc!.riskScore, 0.5);
  const py = runner.calls.find((c) => c.args.includes("python"))!;
  assert.equal(py.opts?.env?.CRG_DATA_DIR, "/c/graph");
  const payload = JSON.parse(py.args[py.args.length - 1]!);
  assert.deepEqual(payload.files, ["src/h.ts"]);
  assert.deepEqual(payload.ranges["src/h.ts"], [[1, 1]]);
});
