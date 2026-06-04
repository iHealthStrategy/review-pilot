import type { TriggerOutcome, TriggerService } from "./trigger-service.js";

/**
 * Periodic polling fallback used when webhooks are unavailable. Thin wrapper
 * around {@link TriggerService.pollAll}; the dedup logic lives in the service,
 * so polling and webhooks never double-enqueue the same PR.
 */
export class Poller {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly service: TriggerService,
    private readonly intervalSeconds: number,
  ) {}

  /** Run a single polling sweep. */
  async runOnce(): Promise<TriggerOutcome[]> {
    return this.service.pollAll();
  }

  /** Start the periodic timer. No-op when interval <= 0 (polling disabled). */
  start(): void {
    if (this.intervalSeconds <= 0 || this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalSeconds * 1000);
    // Don't keep the event loop alive solely for polling.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
