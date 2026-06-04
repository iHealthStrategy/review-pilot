import type { ReviewEngineKind } from "../domain/entities.js";
import type { CommandRunner } from "./command-runner.js";
import { buildProjectSummaryPrompt, buildReviewPrompt, parseFindings } from "./prompt.js";
import type { FindingDraft, ReviewContext, ReviewEngine } from "./review-engine.js";

export interface ExternalEngineConfig {
  /** Executable to invoke (e.g. `cursor-agent`, `claude`, `codex`). */
  command: string;
  /** Args passed before the prompt placeholder / stdin delivery. */
  args?: string[];
  /**
   * How the review prompt is delivered to the CLI:
   *  - `"stdin"` (default): prompt is written to the child's stdin.
   *  - `"arg"`: prompt is appended as the final argument.
   */
  promptVia?: "stdin" | "arg";
  /** Hard timeout for the invocation (ms). 0 = no timeout. */
  timeoutMs?: number;
}

/**
 * CLI-backed review engine — the integration for Cursor / Claude Code / Codex.
 * It builds a review prompt from the {@link ReviewContext} (PR metadata + repo
 * structure + diff, pinned to a strict JSON output schema), runs the configured
 * agent NON-INTERACTIVELY inside the synced workspace (so it can read any file
 * for context), and parses the structured findings from its stdout.
 *
 * The command, args, prompt-delivery and {@link CommandRunner} are all
 * injectable, so the adapter is verified with a fake runner + recorded output —
 * no real tool required.
 */
export class ExternalCliEngine implements ReviewEngine {
  constructor(
    readonly kind: ReviewEngineKind,
    private readonly runner: CommandRunner,
    private readonly config: ExternalEngineConfig,
  ) {}

  async review(ctx: ReviewContext): Promise<FindingDraft[]> {
    const stdout = await this.runPrompt(buildReviewPrompt(ctx), ctx.workspaceDir);
    try {
      return parseFindings(stdout);
    } catch (err) {
      throw new Error(
        `${this.kind} engine output could not be parsed: ${(err as Error).message}`,
      );
    }
  }

  async summarize(ctx: ReviewContext): Promise<string> {
    const stdout = await this.runPrompt(buildProjectSummaryPrompt(ctx), ctx.workspaceDir);
    return stdout.trim();
  }

  /** Run the configured CLI with a prompt (stdin or arg), returning stdout. */
  private async runPrompt(prompt: string, cwd: string): Promise<string> {
    const baseArgs = [...(this.config.args ?? [])];
    const via = this.config.promptVia ?? "stdin";
    const args = via === "arg" ? [...baseArgs, prompt] : baseArgs;

    const result = await this.runner.run(this.config.command, args, {
      cwd,
      timeoutMs: this.config.timeoutMs,
      ...(via === "stdin" ? { input: prompt } : {}),
    });

    if (result.code !== 0) {
      throw new Error(
        `${this.kind} engine (${this.config.command}) exited ${result.code}: ` +
          `${result.stderr.slice(0, 300) || result.stdout.slice(0, 300)}`,
      );
    }
    return result.stdout;
  }
}
