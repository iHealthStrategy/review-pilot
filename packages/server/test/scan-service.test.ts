import assert from "node:assert/strict";
import { test } from "node:test";
import { MockReviewEngine } from "../src/review/mock-engine.js";
import type { CommandResult, CommandRunner } from "../src/review/command-runner.js";
import { ScheduledScanService } from "../src/schedule/scan-service.js";
import type { ScheduleConfig } from "../src/schedule/schedule.js";
import type { ReviewContext, ReviewEngine } from "../src/review/review-engine.js";
import type { BaseGraphRef, GraphCacheService } from "../src/review/graph-cache.js";
import type { StructuralContext } from "../src/review/structural-context.js";

/** Fake git: matches on the joined args, returns canned stdout, records calls. */
class FakeGit implements CommandRunner {
  readonly calls: { args: string[]; env?: Record<string, string> }[] = [];
  constructor(private readonly responses: Array<[RegExp, string]>) {}
  async run(_cmd: string, args: string[], opts?: { env?: Record<string, string> }): Promise<CommandResult> {
    this.calls.push({ args, env: opts?.env });
    const joined = args.join(" ");
    const match = this.responses.find(([re]) => re.test(joined));
    return { code: 0, stdout: match ? match[1] : "", stderr: "" };
  }
}

const config: ScheduleConfig = {
  id: "sch_1",
  name: "nightly",
  platform: "github",
  repoFullName: "acme/demo",
  cloneUrl: "https://github.com/acme/demo.git",
  branches: ["main"],
  timeOfDay: "02:00",
  timezone: "Asia/Shanghai",
  lookbackHours: 24,
  delivery: { type: "feishu", webhookUrl: "https://hook" },
  enabled: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function makeService(git: FakeGit) {
  return new ScheduledScanService({
    git,
    createEngine: () => new MockReviewEngine(),
    defaultEngine: "mock",
    enabledEngines: ["mock"],
    scan: async () => ["src/mod.ts", "README.md"],
  });
}

/** Captures the context handed to the engine (to inspect structuralContext). */
class CapturingEngine implements ReviewEngine {
  readonly kind = "claude-code" as const;
  captured?: ReviewContext;
  async review(ctx: ReviewContext) {
    this.captured = ctx;
    return [];
  }
}

/** Fake cache: one base graph, query returns a fixed StructuralContext. */
class FakeGraphCache {
  queryArgs?: { files: string[]; ranges: Map<string, Array<[number, number]>> };
  async ensureBaseGraph(): Promise<BaseGraphRef> {
    return { srcRoot: "/cache/src", dataDir: "/cache/graph" };
  }
  async query(
    _ref: BaseGraphRef,
    files: string[],
    ranges: Map<string, Array<[number, number]>>,
  ): Promise<StructuralContext> {
    this.queryArgs = { files, ranges };
    return {
      riskScore: 0.7,
      summary: "s",
      reviewPriorities: [
        { name: "doStuff", kind: "Function", filePath: "/cache/src/src/mod.ts", lineStart: 1, riskScore: 0.7 },
      ],
      testGaps: [],
      affectedFlows: [],
    };
  }
}

test("ScheduledScanService: injects structural context into each branch review", async () => {
  const git = new FakeGit([
    [/log refs\/remotes\/origin\/main/, "ccc222\n"],
    [/diff --name-status/, "M\tsrc/mod.ts\n"],
    [/diff .* -- src\/mod\.ts/, "@@ -1 +1,2 @@\n+y\n ctx"],
  ]);
  const engine = new CapturingEngine();
  const cache = new FakeGraphCache();
  const service = new ScheduledScanService({
    git,
    createEngine: () => engine,
    defaultEngine: "claude-code",
    enabledEngines: ["claude-code"],
    scan: async () => ["src/mod.ts"],
    graphCache: cache as unknown as GraphCacheService,
    structuralContext: true,
  });

  await service.scan(config, new Date("2026-06-10T20:00:00Z"));

  assert.ok(engine.captured?.structuralContext, "branch review should carry structural context");
  assert.match(engine.captured!.structuralContext!, /Structural context/);
  assert.match(engine.captured!.structuralContext!, /doStuff — src\/mod\.ts:1/);
  // The branch's changed file + ranges were passed to the read-only query.
  assert.deepEqual(cache.queryArgs?.files, ["src/mod.ts"]);
  assert.deepEqual(cache.queryArgs?.ranges.get("src/mod.ts"), [[1, 1]]);
});

test("ScheduledScanService: reviews today's aggregate diff per branch", async () => {
  const git = new FakeGit([
    [/log refs\/remotes\/origin\/main/, "ccc222\nbbb111\n"], // two commits (newest first)
    [/diff --name-status/, "A\tsrc/new.ts\nM\tsrc/mod.ts\n"],
    [/diff .* -- src\/new\.ts/, "@@ +1 @@\n+x"],
    [/diff .* -- src\/mod\.ts/, "@@ +1 @@\n+y"],
  ]);
  const result = await makeService(git).scan(config, new Date("2026-06-10T20:00:00Z"));

  assert.equal(result.repoFullName, "acme/demo");
  assert.equal(result.branches.length, 1);
  assert.equal(result.branches[0]!.branch, "main");
  assert.equal(result.branches[0]!.commitCount, 2);
  assert.equal(result.branches[0]!.findings.length, 2); // one per changed file
  assert.equal(result.totalFindings, 2);

  // Clone runs WITHOUT `-C dir` (cloning into the cwd breaks git).
  const cloneCall = git.calls.find((c) => c.args.includes("clone"));
  assert.equal(cloneCall?.args[0], "clone");
  assert.ok(!cloneCall?.args.includes("-C"));

  // Full-ref range (unambiguous); log uses since with TZ env.
  assert.ok(git.calls.some((c) => c.args.join(" ").includes("bbb111^..refs/remotes/origin/main")));
  const logCall = git.calls.find((c) => c.args.includes("log"));
  assert.equal(logCall?.env?.TZ, "Asia/Shanghai");
  // Rolling window (default 24h), not "since midnight".
  assert.ok(logCall?.args.includes("--since=24 hours ago"));
});

test("ScheduledScanService: clones the provider-resolved (auth) URL when given", async () => {
  const git = new FakeGit([
    [/log refs\/remotes\/origin\/main/, "aaa\n"],
    [/diff --name-status/, "M\tsrc/a.ts\n"],
    [/diff .* -- src\/a\.ts/, "@@ +1 @@\n+z"],
  ]);
  const service = new ScheduledScanService({
    git,
    createEngine: () => new MockReviewEngine(),
    defaultEngine: "mock",
    enabledEngines: ["mock"],
    scan: async () => ["src/a.ts"],
    resolveCloneUrl: async (_p, fn) => `https://x-access-token:TOK@github.com/${fn}.git`,
  });
  await service.scan(config, new Date("2026-06-10T20:00:00Z"));
  const cloneCall = git.calls.find((c) => c.args.includes("clone"));
  assert.ok(cloneCall?.args.some((a) => a.includes("x-access-token:TOK@github.com/acme/demo.git")));
});

test("ScheduledScanService: one branch's review failure doesn't abort the scan", async () => {
  const git = new FakeGit([
    [/for-each-ref/, "good\nbad\n"],
    [/log refs\/remotes\/origin\/good/, "g1\n"],
    [/log refs\/remotes\/origin\/bad/, "b1\n"],
    [/diff --name-status/, "M\tsrc/a.ts\n"],
    [/diff .* -- src\/a\.ts/, "@@ +1 @@\n+z"],
  ]);
  // Engine throws for branch "bad" (e.g. unparseable output), succeeds for "good".
  const engine = {
    kind: "mock" as const,
    review: async (ctx: { pullRequest: { sourceBranch: string } }) => {
      if (ctx.pullRequest.sourceBranch === "bad") throw new Error("output could not be parsed");
      return [{ filePath: "src/a.ts", severity: "minor" as const, title: "t", detail: "d" }];
    },
  };
  const service = new ScheduledScanService({
    git,
    createEngine: () => engine,
    defaultEngine: "mock",
    enabledEngines: ["mock"],
    scan: async () => ["src/a.ts"],
  });
  const result = await service.scan({ ...config, branches: [] }, new Date("2026-06-10T20:00:00Z"));

  assert.equal(result.branches.length, 2);
  const good = result.branches.find((b) => b.branch === "good")!;
  const bad = result.branches.find((b) => b.branch === "bad")!;
  assert.equal(good.findings.length, 1);
  assert.equal(bad.findings.length, 0);
  assert.match(bad.error ?? "", /could not be parsed/);
  assert.equal(result.totalFindings, 1); // failed branch contributes 0
});

test("ScheduledScanService: a branch with no commits today is skipped", async () => {
  const git = new FakeGit([[/log refs\/remotes\/origin\/main/, ""]]); // no commits today
  const result = await makeService(git).scan(config, new Date("2026-06-10T20:00:00Z"));
  assert.equal(result.branches.length, 0);
  assert.equal(result.totalFindings, 0);
});

test("ScheduledScanService: enumerates all remote branches when none configured", async () => {
  const git = new FakeGit([
    // for-each-ref --format=%(refname:lstrip=3) yields bare branch names and no
    // HEAD-pointer noise — "main" and "dev" only.
    [/for-each-ref/, "HEAD\nmain\ndev\n"],
    [/log refs\/remotes\/origin\/main/, "aaa\n"],
    [/log refs\/remotes\/origin\/dev/, ""],
    [/diff --name-status/, "M\tsrc/a.ts\n"],
    [/diff .* -- src\/a\.ts/, "@@ +1 @@\n+z"],
  ]);
  const result = await makeService(git).scan(
    { ...config, branches: [] },
    new Date("2026-06-10T20:00:00Z"),
  );
  // main had a commit (1 finding); dev had none (skipped); HEAD ignored.
  assert.equal(result.branches.length, 1);
  assert.equal(result.branches[0]!.branch, "main");
});
