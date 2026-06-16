import {
  type CommandRunner,
  ProcessCommandRunner,
} from "../../../server/src/review/command-runner.js";
import { filterToChangedLines } from "../../../server/src/review/diff-lines.js";
import type {
  FindingDraft,
  ReviewContext,
} from "../../../server/src/review/review-engine.js";
import { scanStructure } from "../../../server/src/review/structure-scanner.js";
import type { ReviewEngineKind } from "../../../server/src/domain/entities.js";
import type { AgentSdkClient } from "../../../server/src/review/agent-sdk-engine.js";
import { runEngine } from "./engine.js";
import { buildLocalDiff, type LocalReviewMode } from "./local-git.js";
import { buildLocalPrompt } from "./prompt-local.js";
import {
  buildStructuralContext,
  renderStructuralContext,
} from "../../../server/src/review/structural-context.js";

export interface LocalReviewOptions {
  /** Review scope. Decides the diff and the prompt. */
  mode: LocalReviewMode;
  /** Base branch for the `branch` scope (default "main"). */
  baseBranch?: string;
  /** Engine to run (default "claude-code"). */
  engineKind?: ReviewEngineKind;
  /** Override the CLI executable / args. */
  command?: string;
  args?: string[];
  /** Model for the agentic engine. */
  model?: string;
  /** Hard timeout per invocation (ms). */
  timeoutMs?: number;
  /** Restrict findings to changed lines (working/branch scopes only). */
  onlyChangedLines?: boolean;
  /** Optional reviewer emphasis. */
  reviewFocus?: string;
  /** Enrich the prompt with code-review-graph structural context (diff scopes). */
  structuralContext?: boolean;
  /** Launcher that exposes the `code-review-graph` package (default "uvx"). */
  crgLauncher?: string;
}

export interface LocalReviewHooks {
  /** Progress / diagnostic log sink. */
  onLog?: (message: string) => void;
  /** Injected for tests. */
  commandRunner?: CommandRunner;
  agentSdkClient?: AgentSdkClient;
  /** Injected structure scanner (defaults to the server's fs walk). */
  scan?: (dir: string) => Promise<string[]>;
}

/**
 * Review the local project at `workspaceDir`. Reuses the server review core:
 * {@link scanStructure} for the whole-codebase overview, the server prompt for
 * diff scopes, the shared engine primitives, and {@link filterToChangedLines}
 * for noise reduction. Returns the produced findings; UI concerns (lists,
 * navigation, diagnostics) live in the VS Code layer.
 */
export async function runLocalReview(
  workspaceDir: string,
  options: LocalReviewOptions,
  hooks: LocalReviewHooks = {},
): Promise<FindingDraft[]> {
  const log = hooks.onLog ?? (() => {});
  const runner = hooks.commandRunner ?? new ProcessCommandRunner();
  const scan = hooks.scan ?? scanStructure;
  const mode = options.mode;
  const engineKind: ReviewEngineKind = options.engineKind ?? "claude-code";

  log(`Scanning project structure…`);
  const structure = await scan(workspaceDir);

  log(`Computing ${mode} diff…`);
  const diff = await buildLocalDiff(runner, workspaceDir, mode, options.baseBranch, log);
  if (mode !== "full" && diff.length === 0) {
    log("No changes detected for this scope.");
    return [];
  }

  const context = buildContext(workspaceDir, structure, diff, mode, options);

  // Optional: precomputed structural signal (risk-scored hotspots, test gaps,
  // affected flows) from the code-review-graph. Diff scopes only; best-effort —
  // a null result (tool unavailable / no graph) leaves the review unchanged.
  // Set on the context so buildReviewPrompt injects it (shared with the server).
  if (options.structuralContext && mode !== "full") {
    const base = mode === "working" ? "HEAD" : options.baseBranch || "main";
    const sc = await buildStructuralContext(
      workspaceDir,
      {
        base,
        ...(options.crgLauncher ? { launcher: options.crgLauncher } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      },
      { commandRunner: runner, onLog: log },
    );
    if (sc) {
      context.structuralContext = renderStructuralContext(sc, workspaceDir);
      log(`Structural context: risk ${sc.riskScore.toFixed(2)}, ${sc.testGaps.length} test gap(s).`);
    }
  }

  const prompt = buildLocalPrompt(context, mode);

  log(`Running ${engineKind} engine…`);
  const drafts = await runEngine({
    kind: engineKind,
    prompt,
    ctx: context,
    ...(options.command ? { command: options.command } : {}),
    ...(options.args && options.args.length ? { args: options.args } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(hooks.commandRunner ? { commandRunner: hooks.commandRunner } : {}),
    ...(hooks.agentSdkClient ? { agentSdkClient: hooks.agentSdkClient } : {}),
  });

  const scoped =
    mode !== "full" && options.onlyChangedLines
      ? filterToChangedLines(drafts, diff)
      : drafts;
  log(`Review complete: ${scoped.length} finding(s).`);
  return scoped;
}

function buildContext(
  workspaceDir: string,
  structure: string[],
  diff: ReviewContext["diff"],
  mode: LocalReviewMode,
  options: LocalReviewOptions,
): ReviewContext {
  const title =
    mode === "full"
      ? "Full project review"
      : mode === "branch"
        ? `Branch changes vs ${options.baseBranch || "main"}`
        : "Working-tree changes";
  return {
    platform: "github",
    repoFullName: workspaceDir,
    pullRequest: {
      number: 0,
      title,
      sourceBranch: "",
      targetBranch: options.baseBranch || "",
      headSha: "",
      author: "",
      url: "",
    },
    structure,
    diff,
    workspaceDir,
    ...(options.reviewFocus && options.reviewFocus.trim()
      ? { reviewFocus: options.reviewFocus.trim() }
      : {}),
  };
}
