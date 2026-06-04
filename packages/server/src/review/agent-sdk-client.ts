import type { AgentSdkClient, AgentSdkRunOptions } from "./agent-sdk-engine.js";

/**
 * Live {@link AgentSdkClient} backed by the official Claude Agent SDK.
 *
 * The SDK is loaded with a dynamic `import()` of a non-literal specifier so it
 * stays a runtime-only dependency (no build/test requirement; installed in the
 * Docker image). It runs the agent loop in `opts.cwd`, restricted to the given
 * tools, and returns the agent's final text — which the engine parses into
 * findings. Auth is handled by the SDK from the environment
 * (`ANTHROPIC_API_KEY`, or Bedrock/Vertex flags).
 *
 * Note: the SDK message/option surface can vary by version; this adapter is
 * intentionally defensive about message shapes. Verify against the installed
 * SDK version when wiring a new release.
 */
export class ClaudeAgentSdkClient implements AgentSdkClient {
  async run(opts: AgentSdkRunOptions): Promise<string> {
    const specifier = "@anthropic-ai/claude-agent-sdk";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import(specifier);
    const query = mod.query ?? mod.default?.query;
    if (typeof query !== "function") {
      throw new Error("claude agent sdk: query() not found in module");
    }

    const abort = new AbortController();
    const timer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => abort.abort(), opts.timeoutMs)
        : undefined;
    timer?.unref?.();

    const options: Record<string, unknown> = {
      cwd: opts.cwd,
      permissionMode: "bypassPermissions",
      abortController: abort,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
      ...(opts.allowedTools ? { allowedTools: opts.allowedTools } : {}),
    };

    let assistantText = "";
    let resultText: string | undefined;
    try {
      for await (const message of query({ prompt: opts.prompt, options })) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const m = message as any;
        if (m?.type === "result") {
          if (typeof m.result === "string") resultText = m.result;
        } else if (m?.type === "assistant") {
          assistantText += extractText(m);
        }
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
    return resultText ?? assistantText;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractText(message: any): string {
  const content = message?.message?.content ?? message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: { type?: string }) => b?.type === "text")
      .map((b: { text?: string }) => b.text ?? "")
      .join("");
  }
  return "";
}
