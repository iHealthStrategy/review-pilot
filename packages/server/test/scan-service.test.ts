import assert from "node:assert/strict";
import { test } from "node:test";
import { MockReviewEngine } from "../src/review/mock-engine.js";
import type { CommandResult, CommandRunner } from "../src/review/command-runner.js";
import { ScheduledScanService } from "../src/schedule/scan-service.js";
import type { ScheduleConfig } from "../src/schedule/schedule.js";

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
