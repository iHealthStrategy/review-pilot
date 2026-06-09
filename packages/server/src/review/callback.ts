import type { CheckConclusion } from "../providers/git-provider.js";
import type { FindingDraft } from "./review-engine.js";

/** Where (and how) to deliver a finished review's result back to the caller. */
export interface CallbackConfig {
  url: string;
  /** Extra headers (e.g. the caller's auth token). */
  headers?: Record<string, string>;
}

/** Standard JSON body POSTed to the callback URL when a task finishes. */
export interface CallbackPayload {
  taskId: string;
  status: "completed" | "failed";
  conclusion?: CheckConclusion;
  findings?: FindingDraft[];
  error?: string;
}

/** Minimal HTTP POST seam (injectable; defaults to global fetch). */
export type CallbackSender = (
  url: string,
  headers: Record<string, string>,
  body: string,
) => Promise<void>;

const fetchSender: CallbackSender = async (url, headers, body) => {
  await fetch(url, { method: "POST", headers, body });
};

/**
 * Deliver a task result to its callback URL as JSON. Best-effort: never throws
 * (a caller's unreachable endpoint must not crash the background review); the
 * outcome is returned so the caller can log it.
 */
export async function deliverCallback(
  callback: CallbackConfig,
  payload: CallbackPayload,
  send: CallbackSender = fetchSender,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await send(
      callback.url,
      { "Content-Type": "application/json", ...(callback.headers ?? {}) },
      JSON.stringify(payload),
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
