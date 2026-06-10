import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CommandResult, CommandRunner } from "../src/review/command-runner.js";
import { cloneWithRetry } from "../src/review/git-clone.js";

class SeqRunner implements CommandRunner {
  calls = 0;
  constructor(private readonly codes: number[]) {}
  async run(): Promise<CommandResult> {
    const code = this.codes[this.calls] ?? 0;
    this.calls += 1;
    return { code, stdout: "", stderr: code === 0 ? "" : "unexpected eof" };
  }
}

test("cloneWithRetry: succeeds on a later attempt after transient failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rp-clone-"));
  const runner = new SeqRunner([1, 1, 0]); // fail, fail, succeed
  await cloneWithRetry(runner, "https://host/x.git", dir);
  assert.equal(runner.calls, 3);
});

test("cloneWithRetry: throws after all attempts fail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rp-clone-"));
  const runner = new SeqRunner([1, 1, 1]);
  await assert.rejects(
    cloneWithRetry(runner, "https://host/x.git", dir),
    /after 3 attempts: unexpected eof/,
  );
});
