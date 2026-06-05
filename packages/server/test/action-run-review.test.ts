import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReviewContext, ReviewEngine } from "../src/review/review-engine.js";
import { buildEngineDeps, runReviewAction } from "../src/action/run-review.js";
import { SpyProvider } from "./spy-provider.js";

function makeEngine(): ReviewEngine & { reviewed?: ReviewContext; summarizeCalls: number } {
  return {
    kind: "claude-agent",
    summarizeCalls: 0,
    async review(ctx) {
      this.reviewed = ctx;
      return [
        { filePath: "src/a.ts", line: 3, severity: "major", title: "Bug", detail: "x" },
        { filePath: "src/b.ts", severity: "info", title: "Nit", detail: "y" },
      ];
    },
    async summarize() {
      this.summarizeCalls += 1;
      return "  it is a monorepo  ";
    },
  };
}

test("runReviewAction: reviews a PR and posts a summary comment (stateless)", async () => {
  const provider = new SpyProvider();
  const engine = makeEngine();
  let writtenInsight: string | undefined;

  const result = await runReviewAction({
    env: {
      GITHUB_REPOSITORY: "acme/demo",
      GITHUB_EVENT_PATH: "/event.json",
      GITHUB_WORKSPACE: "/work",
    },
    readEvent: async () => ({
      pull_request: { number: 7 },
      repository: { full_name: "acme/demo" },
    }),
    provider,
    engine,
    engineKind: "claude-agent",
    scan: async () => ["README.md", "src/a.ts"],
    readInsight: async () => undefined, // cache miss → generate
    writeInsight: async (s) => {
      writtenInsight = s;
    },
  });

  assert.equal(result.prNumber, 7);
  assert.equal(result.findings, 2);
  assert.match(result.summary, /ReviewPilot review/); // summary exposed for outputs
  // Comment written back via the provider (no listComments → fresh post).
  assert.equal(provider.comments.length, 1);
  assert.match(provider.comments[0]!.body, /ReviewPilot review/);
  assert.match(provider.comments[0]!.body, /2 finding/);

  // Project understanding was generated, cached, and fed into the review.
  assert.equal(engine.summarizeCalls, 1);
  assert.equal(writtenInsight, "it is a monorepo");
  assert.equal(engine.reviewed?.projectInsight, "it is a monorepo");
  assert.equal(engine.reviewed?.workspaceDir, "/work");
  assert.equal(engine.reviewed?.pullRequest.number, 7);

  // A check run is published; with no gate set, findings are informational.
  assert.equal(result.conclusion, "neutral");
  assert.equal(result.gateFailed, false);
  assert.equal(provider.checkRuns.length, 1);
  assert.equal(provider.checkRuns[0]?.conclusion, "neutral");
  assert.equal(provider.checkRuns[0]?.headSha, "abc123");

  // Inline annotation only for the finding that has a line (src/a.ts:3, major).
  const annotations = provider.checkRuns[0]?.annotations ?? [];
  assert.equal(annotations.length, 1);
  assert.equal(annotations[0]?.path, "src/a.ts");
  assert.equal(annotations[0]?.startLine, 3);
  assert.equal(annotations[0]?.level, "failure"); // major → failure
});

test("runReviewAction: FAIL_ON_SEVERITY trips the gate (failure conclusion)", async () => {
  const provider = new SpyProvider();
  const engine = makeEngine(); // produces a 'major' finding
  const result = await runReviewAction({
    env: {
      GITHUB_REPOSITORY: "acme/demo",
      GITHUB_WORKSPACE: "/work",
      PR_NUMBER: "7",
      FAIL_ON_SEVERITY: "major",
    },
    provider,
    engine,
    engineKind: "claude-agent",
    scan: async () => [],
    readInsight: async () => "cached",
  });
  assert.equal(result.gateFailed, true);
  assert.equal(result.conclusion, "failure");
  assert.equal(provider.checkRuns[0]?.conclusion, "failure");
});

test("runReviewAction: gate not tripped when findings are below threshold", async () => {
  const provider = new SpyProvider();
  const engine = makeEngine(); // highest severity is 'major'
  const result = await runReviewAction({
    env: {
      GITHUB_REPOSITORY: "acme/demo",
      GITHUB_WORKSPACE: "/work",
      PR_NUMBER: "7",
      FAIL_ON_SEVERITY: "critical",
    },
    provider,
    engine,
    engineKind: "claude-agent",
    scan: async () => [],
    readInsight: async () => "cached",
  });
  assert.equal(result.gateFailed, false);
  assert.equal(result.conclusion, "neutral");
});

test("runReviewAction: CHECK_RUN=false skips publishing a check", async () => {
  const provider = new SpyProvider();
  const result = await runReviewAction({
    env: {
      GITHUB_REPOSITORY: "acme/demo",
      GITHUB_WORKSPACE: "/work",
      PR_NUMBER: "7",
      CHECK_RUN: "false",
    },
    provider,
    engine: makeEngine(),
    engineKind: "claude-agent",
    scan: async () => [],
    readInsight: async () => "cached",
  });
  assert.equal(provider.checkRuns.length, 0);
  assert.equal(result.conclusion, "neutral");
});

test("runReviewAction: uses a cached insight without regenerating", async () => {
  const provider = new SpyProvider();
  const engine = makeEngine();
  const result = await runReviewAction({
    env: {
      GITHUB_REPOSITORY: "acme/demo",
      GITHUB_EVENT_PATH: "/event.json",
      GITHUB_WORKSPACE: "/work",
    },
    readEvent: async () => ({ number: 9 }),
    provider,
    engine,
    engineKind: "claude-agent",
    scan: async () => [],
    readInsight: async () => "cached understanding",
  });
  assert.equal(result.prNumber, 9);
  assert.equal(engine.summarizeCalls, 0); // cache hit → no regeneration
  assert.equal(engine.reviewed?.projectInsight, "cached understanding");
});

test("runReviewAction: runs locally from PR_NUMBER with no event file", async () => {
  const provider = new SpyProvider();
  const engine = makeEngine();
  // No readEvent provided — number comes from PR_NUMBER (manual/local trial).
  const result = await runReviewAction({
    env: {
      GITHUB_REPOSITORY: "acme/demo",
      GITHUB_WORKSPACE: "/work",
      PR_NUMBER: "12",
    },
    provider,
    engine,
    engineKind: "claude-code",
    scan: async () => [],
    readInsight: async () => "cached",
  });
  assert.equal(result.prNumber, 12);
  assert.equal(provider.comments.length, 1);
  assert.equal(provider.comments[0]?.number, 12);
});

test("runReviewAction: ONLY_CHANGED_LINES drops findings off the diff", async () => {
  // Diff adds src/a.ts lines 2-4; finding on line 3 stays, src/b.ts (no line,
  // not in diff) is dropped.
  const provider = new SpyProvider("github", [
    { path: "src/a.ts", status: "modified", patch: "@@ -1,1 +1,4 @@\n a\n+b\n+c\n+d" },
  ]);
  const engine = makeEngine();
  const result = await runReviewAction({
    env: {
      GITHUB_REPOSITORY: "acme/demo",
      GITHUB_WORKSPACE: "/work",
      PR_NUMBER: "7",
      ONLY_CHANGED_LINES: "true",
    },
    provider,
    engine,
    engineKind: "claude-agent",
    scan: async () => [],
    readInsight: async () => "cached",
  });
  assert.equal(result.findings, 1); // only src/a.ts:3 survives
  assert.equal(provider.checkRuns[0]?.annotations?.length, 1);
});

test("buildEngineDeps: action honors REVIEW_ENGINE_ARGS / COMMAND / timeout", () => {
  const deps = buildEngineDeps(
    {
      REVIEW_ENGINE_ARGS: "-p --output-format text --dangerously-skip-permissions",
      REVIEW_ENGINE_COMMAND: "claude",
      ENGINE_TIMEOUT_MS: "120000",
      REVIEW_AGENT_MODEL: "claude-opus-4-6",
    } as NodeJS.ProcessEnv,
    "claude-code",
  );
  assert.deepEqual(deps.args?.["claude-code"], [
    "-p",
    "--output-format",
    "text",
    "--dangerously-skip-permissions",
  ]);
  assert.equal(deps.commands?.["claude-code"], "claude");
  assert.equal(deps.timeoutMs, 120000);
  assert.equal(deps.agent?.model, "claude-opus-4-6");
});

test("runReviewAction: errors clearly when not a pull_request event", async () => {
  await assert.rejects(
    runReviewAction({
      env: {
        GITHUB_REPOSITORY: "acme/demo",
        GITHUB_EVENT_PATH: "/event.json",
        GITHUB_WORKSPACE: "/work",
      },
      readEvent: async () => ({}),
      provider: new SpyProvider(),
      engine: makeEngine(),
      engineKind: "claude-agent",
      scan: async () => [],
    }),
    /no pull request number/,
  );
});
