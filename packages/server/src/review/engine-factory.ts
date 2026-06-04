import type { AppConfig } from "../config.js";
import type { Project, ReviewEngineKind } from "../domain/entities.js";
import {
  type AgentSdkClient,
  AgentSdkEngine,
  type AgentSdkEngineConfig,
} from "./agent-sdk-engine.js";
import { ClaudeAgentSdkClient } from "./agent-sdk-client.js";
import { type CommandRunner, ProcessCommandRunner } from "./command-runner.js";
import { type ExternalEngineConfig, ExternalCliEngine } from "./external-engine.js";
import { MockReviewEngine } from "./mock-engine.js";
import type { ReviewEngine } from "./review-engine.js";

/** External engines invoked as a non-interactive CLI. */
type CliEngineKind = "cursor" | "claude-code" | "codex";

/**
 * Default non-interactive invocation per CLI engine. The prompt is fed on
 * stdin (avoids arg-length limits) and the agent runs in the synced workspace.
 * These are sensible defaults; any of command/args/promptVia can be overridden
 * via {@link ReviewEngineDeps} (e.g. from configuration) for a given site's CLI
 * version or flags.
 */
const DEFAULT_INVOCATION: Record<CliEngineKind, Omit<ExternalEngineConfig, "timeoutMs">> = {
  // Claude Code: print mode reads the prompt from stdin and prints the result.
  "claude-code": { command: "claude", args: ["-p", "--output-format", "text"], promptVia: "stdin" },
  // Cursor agent: non-interactive print mode.
  cursor: { command: "cursor-agent", args: ["-p", "--output-format", "text"], promptVia: "stdin" },
  // Codex: non-interactive exec; prompt on stdin.
  codex: { command: "codex", args: ["exec"], promptVia: "stdin" },
};

export interface ReviewEngineDeps {
  commandRunner?: CommandRunner;
  /** Override the executable for any external engine. */
  commands?: Partial<Record<ReviewEngineKind, string>>;
  /** Override the args for any external engine. */
  args?: Partial<Record<ReviewEngineKind, string[]>>;
  /** Hard timeout applied to external engine invocations (ms). */
  timeoutMs?: number;
  /** Injected Agent SDK client (fake in tests; live SDK in production). */
  agentSdkClient?: AgentSdkClient;
  /** Agent SDK tuning (model, maxTurns, allowedTools). */
  agent?: Omit<AgentSdkEngineConfig, "timeoutMs">;
}

/** Construct a {@link ReviewEngine} for the given kind. */
export function createReviewEngine(
  kind: ReviewEngineKind,
  deps: ReviewEngineDeps = {},
): ReviewEngine {
  if (kind === "mock") return new MockReviewEngine();
  if (kind === "claude-agent") {
    const client = deps.agentSdkClient ?? new ClaudeAgentSdkClient();
    return new AgentSdkEngine(client, {
      ...deps.agent,
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    });
  }
  const runner = deps.commandRunner ?? new ProcessCommandRunner();
  const invocation = DEFAULT_INVOCATION[kind];
  const config: ExternalEngineConfig = {
    command: deps.commands?.[kind] ?? invocation.command,
    args: deps.args?.[kind] ?? invocation.args,
    promptVia: invocation.promptVia,
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
  };
  return new ExternalCliEngine(kind, runner, config);
}

/**
 * Pick the engine kind for a project. The project's `defaultEngine` is used
 * when set, otherwise the global default. The chosen engine must be allowed
 * BOTH globally (config enabled list — the site-wide source of allowed tools)
 * AND, when a project is given, by that project's own `enabledEngines`.
 */
export function selectEngineKind(
  config: AppConfig,
  project?: Pick<Project, "defaultEngine" | "enabledEngines">,
): ReviewEngineKind {
  const chosen = project?.defaultEngine ?? config.review.defaultEngine;
  if (!config.review.enabledEngines.includes(chosen)) {
    throw new Error(
      `Engine '${chosen}' is not enabled globally. Enabled: ${config.review.enabledEngines.join(", ")}.`,
    );
  }
  if (project && !project.enabledEngines.includes(chosen)) {
    throw new Error(
      `Engine '${chosen}' is not enabled for this project. Project engines: ${project.enabledEngines.join(", ")}.`,
    );
  }
  return chosen;
}
