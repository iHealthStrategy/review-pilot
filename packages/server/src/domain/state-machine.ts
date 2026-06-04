import type { JobStatus } from "./entities.js";

/**
 * ReviewJob lifecycle state machine.
 *
 *   pending ──▶ running ──▶ succeeded
 *      │           └──────▶ failed
 *      └──────────────────▶ failed   (e.g. validation/setup error before run)
 *   failed ──▶ pending                (requeue for retry)
 *
 * Terminal `succeeded` is final. `failed` may be requeued to `pending`.
 */
const TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  pending: ["running", "failed"],
  running: ["succeeded", "failed"],
  succeeded: [],
  failed: ["pending"],
};

/** Whether a transition from `from` to `to` is permitted. */
export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Allowed next states from a given status (defensive copy). */
export function nextStates(from: JobStatus): JobStatus[] {
  return [...TRANSITIONS[from]];
}

/** True for states that can never transition again. */
export function isTerminal(status: JobStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** Error thrown when an illegal transition is attempted. */
export class InvalidTransitionError extends Error {
  constructor(
    readonly from: JobStatus,
    readonly to: JobStatus,
  ) {
    super(`Illegal ReviewJob transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

/** Throw {@link InvalidTransitionError} unless the transition is allowed. */
export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}
