import type { ReviewEngineKind } from "../domain/entities.js";
import { buildProjectSummaryPrompt, buildReviewPrompt, parseFindings } from "./prompt.js";
import {
  estimateTokens,
  type FindingDraft,
  type ReviewContext,
  type ReviewEngine,
  type UsageCounts,
} from "./review-engine.js";

/** Real token usage reported by the SDK's result message. */
export interface SdkUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Options for one agentic review run. */
export interface AgentSdkRunOptions {
  prompt: string;
  /** Working directory the agent explores (the synced full checkout). */
  cwd: string;
  model?: string;
  maxTurns?: number;
  /**
   * Tools the agent may use. Defaults to READ-ONLY exploration (no Bash/Write),
   * so reviewing an untrusted PR checkout can't run arbitrary commands or
   * exfiltrate process secrets.
   */
  allowedTools?: string[];
  timeoutMs?: number;
  /** Called with real token usage when the SDK reports it (result message). */
  onUsage?: (usage: SdkUsage) => void;
}

/**
 * Port over the Claude Agent SDK. Abstracts "run an agentic review in this
 * checkout and give me its final text output", so the engine is testable with
 * a fake and the SDK stays an optional runtime-only dependency.
 */
export interface AgentSdkClient {
  run(opts: AgentSdkRunOptions): Promise<string>;
}

export interface AgentSdkEngineConfig {
  model?: string;
  maxTurns?: number;
  allowedTools?: string[];
  timeoutMs?: number;
}

const DEFAULT_READONLY_TOOLS = ["Read", "Grep", "Glob"];

/**
 * Review engine backed by the **Claude Agent SDK** — the same agentic engine as
 * Claude Code, driven programmatically. The agent runs in the synced checkout
 * and autonomously reads/greps files to understand the whole project before
 * judging the diff, then returns findings in our strict JSON schema. Auth is by
 * `ANTHROPIC_API_KEY` (or Bedrock/Vertex env), so it is server-appropriate
 * while keeping Claude Code's project-understanding + planning ability.
 */
export class AgentSdkEngine implements ReviewEngine {
  readonly kind: ReviewEngineKind = "claude-agent";
  lastUsage?: UsageCounts;

  constructor(
    private readonly client: AgentSdkClient,
    private readonly config: AgentSdkEngineConfig = {},
  ) {}

  async review(ctx: ReviewContext): Promise<FindingDraft[]> {
    const prompt = buildReviewPrompt(ctx);
    let real: SdkUsage | undefined;
    const output = await this.client.run({
      prompt,
      cwd: ctx.workspaceDir,
      allowedTools: this.config.allowedTools ?? DEFAULT_READONLY_TOOLS,
      onUsage: (u) => (real = u),
      ...(this.config.model ? { model: this.config.model } : {}),
      ...(this.config.maxTurns ? { maxTurns: this.config.maxTurns } : {}),
      ...(this.config.timeoutMs ? { timeoutMs: this.config.timeoutMs } : {}),
    });
    // Prefer the SDK's real usage; fall back to a chars/4 estimate.
    this.lastUsage = real
      ? {
          inputTokens: real.inputTokens,
          outputTokens: real.outputTokens,
          totalTokens: real.inputTokens + real.outputTokens,
          estimated: false,
        }
      : {
          inputTokens: estimateTokens(prompt),
          outputTokens: estimateTokens(output),
          totalTokens: estimateTokens(prompt) + estimateTokens(output),
          estimated: true,
        };
    try {
      return parseFindings(output);
    } catch (err) {
      throw new Error(
        `claude-agent engine output could not be parsed: ${(err as Error).message}`,
      );
    }
  }

  async summarize(ctx: ReviewContext): Promise<string> {
    const prompt = buildProjectSummaryPrompt(ctx);
    return (
      await this.client.run({
        prompt,
        cwd: ctx.workspaceDir,
        allowedTools: this.config.allowedTools ?? DEFAULT_READONLY_TOOLS,
        ...(this.config.model ? { model: this.config.model } : {}),
        ...(this.config.maxTurns ? { maxTurns: this.config.maxTurns } : {}),
        ...(this.config.timeoutMs ? { timeoutMs: this.config.timeoutMs } : {}),
      })
    ).trim();
  }
}
