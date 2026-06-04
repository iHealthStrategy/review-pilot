import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { ProcessCommandRunner } from "../src/review/command-runner.js";
import { GitCloner } from "../src/review/cloner.js";
import {
  createReviewEngine,
  selectEngineKind,
} from "../src/review/engine-factory.js";
import { ExternalCliEngine } from "../src/review/external-engine.js";
import { MockReviewEngine } from "../src/review/mock-engine.js";
import type { ReviewContext } from "../src/review/review-engine.js";
import { scanStructure } from "../src/review/structure-scanner.js";
import { FakeCommandRunner } from "./fake-cloner.js";

function ctx(overrides: Partial<ReviewContext> = {}): ReviewContext {
  return {
    platform: "github",
    repoFullName: "acme/demo",
    pullRequest: {
      number: 7,
      title: "Add feature",
      sourceBranch: "feat",
      targetBranch: "main",
      headSha: "abc123",
      author: "alice",
      url: "https://example/pr/7",
    },
    structure: ["README.md", "src/mod.ts"],
    diff: [
      { path: "src/new.ts", status: "added" },
      { path: "src/mod.ts", status: "modified" },
    ],
    workspaceDir: "/tmp/ws",
    ...overrides,
  };
}

test("MockReviewEngine: one finding per changed file, grounded in full structure", async () => {
  const findings = await new MockReviewEngine().review(ctx());
  assert.equal(findings.length, 2);
  const added = findings.find((f) => f.filePath === "src/new.ts");
  assert.equal(added?.severity, "minor");
  // The added file is not in the synced tree → engine notes whole-repo context.
  assert.match(added!.detail, /full repository \(2 files\)/);
  assert.match(added!.detail, /not present in synced tree/);
  const removed = await new MockReviewEngine().review(
    ctx({ diff: [{ path: "src/gone.ts", status: "removed" }] }),
  );
  assert.equal(removed[0]?.severity, "info");
});

test("scanStructure: lists files sorted and ignores noise dirs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reviewpilot-scan-"));
  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await mkdir(join(dir, "node_modules", "x"), { recursive: true });
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, "src", "b.ts"), "b");
    await writeFile(join(dir, "src", "a.ts"), "a");
    await writeFile(join(dir, "README.md"), "r");
    await writeFile(join(dir, "node_modules", "x", "dep.js"), "d");
    await writeFile(join(dir, ".git", "HEAD"), "ref");
    const files = await scanStructure(dir);
    assert.deepEqual(files, ["README.md", "src/a.ts", "src/b.ts"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ExternalCliEngine: parses JSON findings from stdout", async () => {
  const runner = new FakeCommandRunner([
    {
      code: 0,
      stdout: JSON.stringify([
        { file: "src/a.ts", line: 10, severity: "major", title: "Bug", detail: "x" },
        { path: "src/b.ts", message: "Style nit" },
      ]),
      stderr: "",
    },
  ]);
  const engine = new ExternalCliEngine("claude-code", runner, {
    command: "claude",
    args: ["-p"],
  });
  const findings = await engine.review(ctx());
  assert.equal(findings.length, 2);
  assert.equal(findings[0]?.filePath, "src/a.ts");
  assert.equal(findings[0]?.severity, "major");
  // Unknown severity falls back to info; message maps to title+detail.
  assert.equal(findings[1]?.filePath, "src/b.ts");
  assert.equal(findings[1]?.severity, "info");
  assert.equal(findings[1]?.title, "Style nit");
  // The agent runs IN the synced workspace and is fed the review prompt on
  // stdin (not the bare workspace path as an arg).
  assert.equal(runner.calls[0]?.cwd, "/tmp/ws");
  assert.match(runner.calls[0]?.input ?? "", /Pull request #7/);
  assert.match(runner.calls[0]?.input ?? "", /JSON array/);
});

test("ExternalCliEngine: tolerates prose + markdown fences around the JSON", async () => {
  const runner = new FakeCommandRunner([
    {
      code: 0,
      stdout:
        "Sure! Here are the issues I found:\n\n```json\n" +
        JSON.stringify([{ file: "src/a.ts", severity: "minor", title: "Nit" }]) +
        "\n```\nLet me know if you want more detail.",
      stderr: "",
    },
  ]);
  const engine = new ExternalCliEngine("claude-code", runner, { command: "claude" });
  const findings = await engine.review(ctx());
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.filePath, "src/a.ts");
});

test("ExternalCliEngine: prompt can be delivered as an argument", async () => {
  const runner = new FakeCommandRunner([{ code: 0, stdout: "[]", stderr: "" }]);
  const engine = new ExternalCliEngine("codex", runner, {
    command: "codex",
    args: ["exec"],
    promptVia: "arg",
  });
  await engine.review(ctx());
  assert.equal(runner.calls[0]?.input, undefined);
  assert.equal(runner.calls[0]?.args[0], "exec");
  assert.match(runner.calls[0]?.args.at(-1) ?? "", /Pull request #7/);
});

test("ExternalCliEngine: non-zero exit throws", async () => {
  const runner = new FakeCommandRunner([{ code: 2, stdout: "", stderr: "boom" }]);
  const engine = new ExternalCliEngine("codex", runner, { command: "codex" });
  await assert.rejects(engine.review(ctx()), /codex engine .* exited 2/);
});

test("AgentSdkEngine: runs the agent in the checkout and parses findings", async () => {
  const { AgentSdkEngine } = await import("../src/review/agent-sdk-engine.js");
  const calls: { prompt: string; cwd: string; allowedTools?: string[]; model?: string }[] = [];
  const client = {
    async run(opts: { prompt: string; cwd: string; allowedTools?: string[]; model?: string }) {
      calls.push(opts);
      return JSON.stringify([
        { file: "src/a.ts", line: 4, severity: "major", title: "Bug", detail: "x" },
      ]);
    },
  };
  const engine = new AgentSdkEngine(client, { model: "claude-sonnet-4-6", maxTurns: 12 });
  assert.equal(engine.kind, "claude-agent");
  const findings = await engine.review(ctx());
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.filePath, "src/a.ts");
  assert.equal(findings[0]?.severity, "major");
  // Agent runs in the synced checkout, gets the review prompt, and defaults to
  // READ-ONLY tools (no Bash/Write) so untrusted PR code can't run commands.
  assert.equal(calls[0]?.cwd, "/tmp/ws");
  assert.match(calls[0]?.prompt ?? "", /Pull request #7/);
  assert.deepEqual(calls[0]?.allowedTools, ["Read", "Grep", "Glob"]);
  assert.equal(calls[0]?.model, "claude-sonnet-4-6");
});

test("engine-factory: builds the claude-agent engine with an injected SDK client", () => {
  const client = { async run() { return "[]"; } };
  const engine = createReviewEngine("claude-agent", { agentSdkClient: client });
  assert.equal(engine.kind, "claude-agent");
});

test("GitCloner: issues clone + fetch + checkout for the head ref", async () => {
  const runner = new FakeCommandRunner();
  const cloner = new GitCloner(runner, { depth: 1 });
  const ws = await cloner.clone("https://host/acme/demo.git", "abc123");
  try {
    const cmds = runner.calls.map((c) => `${c.command} ${c.args.join(" ")}`);
    assert.ok(cmds[0]?.startsWith("git clone --depth 1 https://host/acme/demo.git"));
    assert.ok(cmds.some((c) => /checkout abc123$/.test(c)));
  } finally {
    await cloner.cleanup(ws);
  }
});

test("engine-factory: builds mock vs external and validates enablement", () => {
  assert.ok(createReviewEngine("mock") instanceof MockReviewEngine);
  const ext = createReviewEngine("cursor", {
    commandRunner: new ProcessCommandRunner(),
    commands: { cursor: "cursor-agent" },
  });
  assert.ok(ext instanceof ExternalCliEngine);
  assert.equal(ext.kind, "cursor");

  const cfg = loadConfig({ REVIEW_ENGINE: "mock", REVIEW_ENGINES_ENABLED: "mock" });
  assert.equal(selectEngineKind(cfg), "mock");
  // A project default not in the GLOBAL enabled list is rejected.
  assert.throws(
    () => selectEngineKind(cfg, { defaultEngine: "codex", enabledEngines: ["codex"] }),
    /not enabled globally/,
  );
  // A project default allowed globally but not in the PROJECT's list is rejected.
  const cfg2 = loadConfig({
    REVIEW_ENGINE: "mock",
    REVIEW_ENGINES_ENABLED: "mock,claude-code",
  });
  assert.throws(
    () => selectEngineKind(cfg2, { defaultEngine: "claude-code", enabledEngines: ["mock"] }),
    /not enabled for this project/,
  );
});

test("buildReviewPrompt: embeds PR metadata, structure and diff with strict schema", async () => {
  const { buildReviewPrompt } = await import("../src/review/prompt.js");
  const prompt = buildReviewPrompt(
    ctx({ diff: [{ path: "src/x.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" }] }),
  );
  assert.match(prompt, /acme\/demo/);
  assert.match(prompt, /Pull request #7/);
  assert.match(prompt, /src\/x\.ts/);
  assert.match(prompt, /```diff/);
  assert.match(prompt, /ONLY a JSON array/);

  // Cached project understanding is injected when present.
  const grounded = buildReviewPrompt(ctx({ projectInsight: "It is a monorepo." }));
  assert.match(grounded, /Project understanding \(cached\)/);
  assert.match(grounded, /It is a monorepo\./);
});
