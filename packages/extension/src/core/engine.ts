import { ClaudeAgentSdkClient } from "../../../server/src/review/agent-sdk-client.js";
import type { AgentSdkClient } from "../../../server/src/review/agent-sdk-engine.js";
import {
  type CommandRunner,
  ProcessCommandRunner,
} from "../../../server/src/review/command-runner.js";
import { MockReviewEngine } from "../../../server/src/review/mock-engine.js";
import { parseFindings } from "../../../server/src/review/prompt.js";
import type {
  FindingDraft,
  ReviewContext,
} from "../../../server/src/review/review-engine.js";
import type { ReviewEngineKind } from "../../../server/src/domain/entities.js";

/** READ-ONLY tool set for the agentic engine — mirrors the server default. */
const AGENT_READONLY_TOOLS = ["Read", "Grep", "Glob"];

/** Default non-interactive CLI invocation per engine — mirrors the server. */
const DEFAULT_INVOCATION: Record<"cursor" | "claude-code" | "codex", {
  command: string;
  args: string[];
}> = {
  "claude-code": { command: "claude", args: ["-p", "--output-format", "text"] },
  cursor: { command: "cursor-agent", args: ["-p", "--output-format", "text"] },
  codex: { command: "codex", args: ["exec"] },
};

export interface RunEngineOptions {
  kind: ReviewEngineKind;
  /** Prebuilt prompt (mode-specific). Ignored by the `mock` engine. */
  prompt: string;
  /** The synced checkout the engine explores (the local workspace). */
  ctx: ReviewContext;
  /** Override the CLI executable (empty/undefined → engine default). */
  command?: string;
  /** Override the CLI args (empty/undefined → engine default). */
  args?: string[];
  /** Model passed to the agentic engine when supported. */
  model?: string;
  /** Hard timeout in ms (0/undefined → none). */
  timeoutMs?: number;
  /** Injected for tests; defaults to the real process/SDK clients. */
  commandRunner?: CommandRunner;
  agentSdkClient?: AgentSdkClient;
}

/**
 * Run a single review, reusing the server's review primitives end to end: the
 * same {@link parseFindings} JSON extractor, the same {@link ProcessCommandRunner}
 * for CLI engines, the same {@link ClaudeAgentSdkClient} for the SDK engine, and
 * the same {@link MockReviewEngine}. The only thing this layer owns is feeding a
 * mode-specific prompt (the engines hardcode their own), so a full-project
 * review can use a whole-project prompt while diff reviews use the server's.
 */
export async function runEngine(opts: RunEngineOptions): Promise<FindingDraft[]> {
  if (opts.kind === "mock") {
    return new MockReviewEngine().review(opts.ctx);
  }

  if (opts.kind === "claude-agent") {
    const client = opts.agentSdkClient ?? new ClaudeAgentSdkClient();
    const stdout = await client.run({
      prompt: opts.prompt,
      cwd: opts.ctx.workspaceDir,
      allowedTools: AGENT_READONLY_TOOLS,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
    return parse(opts.kind, stdout);
  }

  const invocation = DEFAULT_INVOCATION[opts.kind];
  if (!invocation) throw new Error(`Unsupported engine: ${opts.kind}`);
  const command = opts.command?.trim() || invocation.command;
  const args = opts.args && opts.args.length ? opts.args : invocation.args;
  const runner = opts.commandRunner ?? new ProcessCommandRunner();

  const result = await runner.run(command, args, {
    cwd: opts.ctx.workspaceDir,
    input: opts.prompt,
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  });
  if (result.code !== 0) {
    const detail = result.stderr.slice(0, 300) || result.stdout.slice(0, 300);
    throw new Error(`${opts.kind} engine (${command}) exited ${result.code}: ${detail}`);
  }
  return parse(opts.kind, result.stdout);
}

function parse(kind: ReviewEngineKind, stdout: string): FindingDraft[] {
  try {
    return parseFindings(stdout);
  } catch (err) {
    const snippet = stdout.trim().slice(0, 300).replace(/\s+/g, " ");
    throw new Error(
      `${kind} engine output could not be parsed: ${(err as Error).message}` +
        (snippet ? ` | output starts: "${snippet}"` : " | output was empty"),
    );
  }
}
