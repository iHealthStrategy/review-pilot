import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  CommandResult,
  CommandRunner,
  CommandRunOptions,
} from "../../server/src/review/command-runner.js";
import { runLocalReview } from "../src/core/local-review.js";

const PATCH = ["@@ -1,2 +1,3 @@", " line1", "+added line", " line2"].join("\n");

/** A scriptable CommandRunner that routes git + engine-CLI invocations. */
class FakeRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: string[] }> = [];
  constructor(private readonly engineStdout: string) {}

  run(
    command: string,
    args: string[],
    _opts?: CommandRunOptions,
  ): Promise<CommandResult> {
    this.calls.push({ command, args });
    const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: "" });

    if (command === "git") {
      if (args.includes("--name-status")) return Promise.resolve(ok("M\ta.ts\n"));
      if (args.includes("ls-files")) return Promise.resolve(ok(""));
      if (args.includes("merge-base")) return Promise.resolve(ok("abc123\n"));
      if (args.includes("diff")) return Promise.resolve(ok(PATCH));
      return Promise.resolve(ok(""));
    }
    // Any engine CLI (e.g. `claude`) returns the canned findings JSON.
    return Promise.resolve(ok(this.engineStdout));
  }
}

const findingsJson = (extra = ""): string =>
  JSON.stringify([
    {
      filePath: "a.ts",
      line: 2,
      severity: "major",
      title: "Bug on changed line",
      detail: "boom",
      suggestion: "fix it",
    },
    ...(extra ? [JSON.parse(extra)] : []),
  ]);

test("working scope: builds diff, runs CLI engine, returns parsed findings", async () => {
  const runner = new FakeRunner(findingsJson());
  const findings = await runLocalReview(
    "/repo",
    { mode: "working", engineKind: "claude-code" },
    { commandRunner: runner, scan: async () => ["a.ts"] },
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.title, "Bug on changed line");
  // It actually invoked the CLI engine (default `claude`).
  assert.ok(runner.calls.some((c) => c.command === "claude"));
});

test("working scope: short-circuits to [] when there is no diff", async () => {
  const runner = new FakeRunner(findingsJson());
  // Override name-status to empty so the diff is empty.
  runner.run = ((command: string, args: string[]) => {
    if (command === "git" && args.includes("--name-status"))
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    if (command === "git" && args.includes("ls-files"))
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  }) as CommandRunner["run"];
  const findings = await runLocalReview(
    "/repo",
    { mode: "working", engineKind: "claude-code" },
    { commandRunner: runner, scan: async () => ["a.ts"] },
  );
  assert.deepEqual(findings, []);
});

test("onlyChangedLines drops findings off the changed lines", async () => {
  const offLine = JSON.stringify({
    filePath: "a.ts",
    line: 99,
    severity: "minor",
    title: "Off the diff",
    detail: "x",
  });
  const runner = new FakeRunner(findingsJson(offLine));
  const findings = await runLocalReview(
    "/repo",
    { mode: "working", engineKind: "claude-code", onlyChangedLines: true },
    { commandRunner: runner, scan: async () => ["a.ts"] },
  );
  // Only the finding on changed line 2 survives.
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.line, 2);
});

test("full scope: no diff is computed; engine still produces findings", async () => {
  const runner = new FakeRunner(findingsJson());
  const findings = await runLocalReview(
    "/repo",
    { mode: "full", engineKind: "claude-code" },
    { commandRunner: runner, scan: async () => ["a.ts", "b.ts"] },
  );
  assert.equal(findings.length, 1);
  // No git diff was needed for the whole-project scope.
  assert.ok(!runner.calls.some((c) => c.args.includes("--name-status")));
});

test("branch scope: uses merge-base range to build the diff", async () => {
  const runner = new FakeRunner(findingsJson());
  await runLocalReview(
    "/repo",
    { mode: "branch", baseBranch: "main", engineKind: "claude-code" },
    { commandRunner: runner, scan: async () => ["a.ts"] },
  );
  assert.ok(runner.calls.some((c) => c.args.includes("merge-base")));
  assert.ok(runner.calls.some((c) => c.args.some((a) => a.includes("abc123..HEAD"))));
});
