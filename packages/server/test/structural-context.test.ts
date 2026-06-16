import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  CommandResult,
  CommandRunner,
  CommandRunOptions,
} from "../src/review/command-runner.js";
import {
  buildStructuralContext,
  renderStructuralContext,
} from "../src/review/structural-context.js";

const DETECT_JSON = JSON.stringify({
  status: "ok",
  risk_score: 0.45,
  summary: "Analyzed 2 changed file(s)",
  changed_functions: [],
  affected_flows: [{ name: "POST /reviews", criticality: 0.7 }],
  test_gaps: [
    { name: "FileScheduleStore", file: "/repo/packages/server/src/schedule/store.ts", line_start: 24 },
  ],
  review_priorities: [
    {
      name: "runConfig",
      kind: "Function",
      file_path: "/repo/packages/server/src/schedule/scheduler.ts",
      line_start: 83,
      risk_score: 0.45,
      is_test: false,
    },
  ],
});

/** Routes the build/update call and the detect (python) call. */
class CrgRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: string[]; opts?: CommandRunOptions }> = [];
  constructor(
    private readonly buildCode: number,
    private readonly detectStdout: string,
    private readonly detectCode = 0,
  ) {}
  run(command: string, args: string[], opts?: CommandRunOptions): Promise<CommandResult> {
    this.calls.push({ command, args, ...(opts ? { opts } : {}) });
    if (args.includes("python")) {
      return Promise.resolve({ code: this.detectCode, stdout: this.detectStdout, stderr: "" });
    }
    return Promise.resolve({ code: this.buildCode, stdout: "", stderr: "boom" });
  }
}

test("parses detect_changes JSON into StructuralContext", async () => {
  const runner = new CrgRunner(0, DETECT_JSON);
  const sc = await buildStructuralContext(
    "/repo",
    { base: "HEAD" },
    { commandRunner: runner, graphExists: () => true },
  );
  assert.ok(sc);
  assert.equal(sc.riskScore, 0.45);
  assert.equal(sc.reviewPriorities[0]!.name, "runConfig");
  assert.equal(sc.testGaps[0]!.name, "FileScheduleStore");
  assert.equal(sc.affectedFlows[0]!.name, "POST /reviews");
  // graph existed → incremental update, not a full build.
  assert.ok(runner.calls.some((c) => c.args.includes("update")));
});

test("pins CRG_DATA_DIR on every subprocess when dataDir is set (job isolation)", async () => {
  const runner = new CrgRunner(0, DETECT_JSON);
  await buildStructuralContext(
    "/repo",
    { base: "HEAD", dataDir: "/ws-42/.code-review-graph" },
    { commandRunner: runner, graphExists: () => true },
  );
  // Both the update/build AND the detect call must carry the per-job data dir.
  assert.ok(runner.calls.length >= 2);
  for (const c of runner.calls) {
    assert.equal(c.opts?.env?.CRG_DATA_DIR, "/ws-42/.code-review-graph");
  }
});

test("checks the dataDir (not the workspace) for an existing graph", async () => {
  const seen: Array<string | undefined> = [];
  const runner = new CrgRunner(0, DETECT_JSON);
  await buildStructuralContext(
    "/repo",
    { base: "HEAD", dataDir: "/cache/acme/graph" },
    {
      commandRunner: runner,
      graphExists: (_dir, dataDir) => {
        seen.push(dataDir);
        return true;
      },
    },
  );
  assert.deepEqual(seen, ["/cache/acme/graph"]);
});

test("runs a full build when the graph does not exist yet", async () => {
  const runner = new CrgRunner(0, DETECT_JSON);
  await buildStructuralContext(
    "/repo",
    { base: "HEAD" },
    { commandRunner: runner, graphExists: () => false },
  );
  assert.ok(runner.calls.some((c) => c.args.includes("build")));
});

test("returns null (non-fatal) when the graph tool fails to build", async () => {
  const runner = new CrgRunner(127, DETECT_JSON);
  const sc = await buildStructuralContext(
    "/repo",
    { base: "HEAD" },
    { commandRunner: runner, graphExists: () => false },
  );
  assert.equal(sc, null);
});

test("returns null when detect reports an error payload", async () => {
  const runner = new CrgRunner(0, JSON.stringify({ status: "error", message: "no graph" }));
  const sc = await buildStructuralContext(
    "/repo",
    { base: "HEAD" },
    { commandRunner: runner, graphExists: () => true },
  );
  assert.equal(sc, null);
});

test("tolerates leading log noise before the JSON on stdout", async () => {
  const runner = new CrgRunner(0, `warn: cloud embeddings\n${DETECT_JSON}`);
  const sc = await buildStructuralContext(
    "/repo",
    { base: "HEAD" },
    { commandRunner: runner, graphExists: () => true },
  );
  assert.ok(sc);
  assert.equal(sc.riskScore, 0.45);
});

test("renders a compact section with repo-relative paths", () => {
  const sc = {
    riskScore: 0.45,
    summary: "x",
    reviewPriorities: [
      { name: "runConfig", kind: "Function", filePath: "/repo/packages/server/src/schedule/scheduler.ts", lineStart: 83, riskScore: 0.45 },
    ],
    testGaps: [{ name: "FileScheduleStore", filePath: "/repo/packages/server/src/schedule/store.ts", lineStart: 24 }],
    affectedFlows: [{ name: "POST /reviews", criticality: 0.7 }],
  };
  const text = renderStructuralContext(sc, "/repo");
  assert.match(text, /Structural context/);
  assert.match(text, /risk 0\.45.*runConfig — packages\/server\/src\/schedule\/scheduler\.ts:83/);
  assert.match(text, /NO test coverage/);
  assert.match(text, /POST \/reviews \(criticality 0\.70\)/);
  // Absolute prefix must not leak into the prompt.
  assert.ok(!text.includes("/repo/packages"));
});
