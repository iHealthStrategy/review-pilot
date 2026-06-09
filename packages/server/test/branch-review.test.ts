import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReviewEngineKind } from "../src/domain/entities.js";
import { BranchReviewService } from "../src/review/branch-review.js";
import type { CommandResult, CommandRunner } from "../src/review/command-runner.js";
import { MockReviewEngine } from "../src/review/mock-engine.js";

/** Fake git: matches on the joined args and returns canned stdout. */
class FakeGit implements CommandRunner {
  readonly calls: string[][] = [];
  constructor(private readonly responses: Array<[RegExp, string]>) {}
  async run(_cmd: string, args: string[]): Promise<CommandResult> {
    this.calls.push(args);
    const joined = args.join(" ");
    const match = this.responses.find(([re]) => re.test(joined));
    return { code: 0, stdout: match ? match[1] : "", stderr: "" };
  }
}

const task = {
  platform: "github" as const,
  repoFullName: "acme/demo",
  cloneUrl: "https://github.com/acme/demo.git",
  headBranch: "feature/x",
  baseBranch: "main",
};

test("BranchReviewService: clones, diffs branches, runs engine over the diff", async () => {
  const git = new FakeGit([
    [/rev-parse/, "deadbeef\n"],
    [/diff --name-status/, "A\tsrc/new.ts\nM\tsrc/mod.ts\n"],
    [/diff .* -- src\/new\.ts/, "@@ -0,0 +1 @@\n+new"],
    [/diff .* -- src\/mod\.ts/, "@@ -1 +1 @@\n-old\n+new"],
  ]);
  const service = new BranchReviewService({
    git,
    createEngine: () => new MockReviewEngine(),
    defaultEngine: "mock",
    enabledEngines: ["mock"],
    scan: async () => ["src/mod.ts", "README.md"],
  });

  const { findings, conclusion } = await service.review(task);

  // One finding per changed file (mock engine).
  assert.equal(findings.length, 2);
  assert.deepEqual(
    findings.map((f) => f.filePath).sort(),
    ["src/mod.ts", "src/new.ts"],
  );
  assert.equal(conclusion, "neutral");

  // It used a three-dot range against the base/head remote refs.
  const diffCall = git.calls.find((c) => c.includes("--name-status"));
  assert.ok(diffCall?.join(" ").includes("origin/main...origin/feature/x"));
  // The workspace was checked out at the head branch.
  assert.ok(git.calls.some((c) => c[2] === "checkout" && c[3] === "feature/x"));
});

test("BranchReviewService: reports success conclusion when the diff is empty", async () => {
  const git = new FakeGit([
    [/rev-parse/, "deadbeef\n"],
    [/diff --name-status/, ""],
  ]);
  const service = new BranchReviewService({
    git,
    createEngine: () => new MockReviewEngine(),
    defaultEngine: "mock",
    enabledEngines: ["mock"],
    scan: async () => [],
  });
  const { findings, conclusion } = await service.review(task);
  assert.equal(findings.length, 0);
  assert.equal(conclusion, "success");
});

test("BranchReviewService: rejects an engine that is not enabled", async () => {
  const git = new FakeGit([]);
  const service = new BranchReviewService({
    git,
    createEngine: () => new MockReviewEngine(),
    defaultEngine: "mock",
    enabledEngines: ["mock"],
    scan: async () => [],
  });
  await assert.rejects(
    service.review({ ...task, engine: "claude-code" as ReviewEngineKind }),
    /not enabled/,
  );
});
