import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  CommandResult,
  CommandRunner,
  CommandRunOptions,
} from "../src/review/command-runner.js";
import type { BaseGraphRef, GraphCacheService } from "../src/review/graph-cache.js";
import type { StructuralContext } from "../src/review/structural-context.js";
import type { ReviewContext } from "../src/review/review-engine.js";
import { buildReviewPrompt } from "../src/review/prompt.js";
import { ensureStructuralContext } from "../src/review/structural-review.js";

/** Returns a base-tip sha for `git rev-parse origin/<base>`. */
class GitRunner implements CommandRunner {
  constructor(private readonly sha: string) {}
  run(_c: string, _a: string[], _o?: CommandRunOptions): Promise<CommandResult> {
    return Promise.resolve({ code: 0, stdout: `${this.sha}\n`, stderr: "" });
  }
}

const SC: StructuralContext = {
  riskScore: 0.6,
  summary: "x",
  reviewPriorities: [
    { name: "handler", kind: "Function", filePath: "/cache/src/src/handler.ts", lineStart: 2, riskScore: 0.6 },
  ],
  testGaps: [{ name: "handler", filePath: "/cache/src/src/handler.ts", lineStart: 2 }],
  affectedFlows: [],
};

const PATCH = ["@@ -1,2 +1,3 @@", " line1", "+added", "+added2", " line2"].join("\n");

/** Minimal stand-in for the cache; records query inputs + the base sha passed in. */
class FakeCache {
  readonly queries: Array<{ files: string[]; ranges: Map<string, Array<[number, number]>> }> = [];
  expectedBaseSha?: string;
  constructor(
    private readonly ref: BaseGraphRef | null,
    private readonly sc: StructuralContext | null,
  ) {}
  async ensureBaseGraph(_repo: unknown, expectedBaseSha?: string): Promise<BaseGraphRef | null> {
    this.expectedBaseSha = expectedBaseSha;
    return this.ref;
  }
  async query(
    _ref: BaseGraphRef,
    files: string[],
    ranges: Map<string, Array<[number, number]>>,
  ): Promise<StructuralContext | null> {
    this.queries.push({ files, ranges });
    return this.sc;
  }
}

function ctx(): ReviewContext {
  return {
    platform: "github",
    repoFullName: "acme/app",
    pullRequest: {
      number: 7, title: "t", sourceBranch: "feat", targetBranch: "main",
      headSha: "deadbeef", author: "a", url: "u",
    },
    structure: ["src/handler.ts"],
    diff: [{ path: "src/handler.ts", status: "modified", patch: PATCH }],
    workspaceDir: "/ws",
  };
}

const repo = { platform: "github", fullName: "acme/app", cloneUrl: "https://x/y.git", baseBranch: "main" };

test("queries the base graph with PR-derived files+ranges and renders a section", async () => {
  const cache = new FakeCache({ srcRoot: "/cache/src", dataDir: "/cache/graph" }, SC);
  const text = await ensureStructuralContext(ctx(), {
    cache: cache as unknown as GraphCacheService,
    repo,
    commandRunner: new GitRunner("base-tip-sha"),
  });
  assert.ok(text);
  assert.match(text, /Structural context/);
  assert.match(text, /handler — src\/handler\.ts:2/);
  // The PR's added lines 2-3 became a single [2,3] range for src/handler.ts.
  assert.equal(cache.queries.length, 1);
  assert.deepEqual(cache.queries[0]!.files, ["src/handler.ts"]);
  assert.deepEqual(cache.queries[0]!.ranges.get("src/handler.ts"), [[2, 3]]);
  // The workspace base tip was passed through to drive cache freshness.
  assert.equal(cache.expectedBaseSha, "base-tip-sha");
});

test("returns undefined when no base graph is available", async () => {
  const cache = new FakeCache(null, SC);
  const text = await ensureStructuralContext(ctx(), {
    cache: cache as unknown as GraphCacheService,
    repo,
    commandRunner: new GitRunner("s"),
  });
  assert.equal(text, undefined);
  assert.equal(cache.queries.length, 0);
});

test("returns undefined when the query yields nothing", async () => {
  const cache = new FakeCache({ srcRoot: "/cache/src", dataDir: "/cache/graph" }, null);
  const text = await ensureStructuralContext(ctx(), {
    cache: cache as unknown as GraphCacheService,
    repo,
    commandRunner: new GitRunner("s"),
  });
  assert.equal(text, undefined);
});

test("buildReviewPrompt injects structuralContext when present", () => {
  const c = ctx();
  c.structuralContext = "## Structural context (from code-review-graph)\nrisk 0.60";
  const prompt = buildReviewPrompt(c);
  assert.match(prompt, /## Structural context \(from code-review-graph\)/);
  // Strict output schema still trails the prompt so parsing is unaffected.
  assert.ok(prompt.lastIndexOf("Structural context") < prompt.lastIndexOf("Output format"));
});

test("buildReviewPrompt omits the section when structuralContext is absent", () => {
  const prompt = buildReviewPrompt(ctx());
  assert.ok(!prompt.includes("Structural context"));
});
