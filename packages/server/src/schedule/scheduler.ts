import { deliverFeishu, type FeishuSender } from "./feishu.js";
import type { ScanResult, ScheduledScanService } from "./scan-service.js";
import type { ScheduleConfig, ScheduleStore } from "./schedule.js";
import { parseTimeOfDay, tzDate, tzMinutes } from "./tz.js";

export interface SchedulerDeps {
  store: ScheduleStore;
  scan: ScheduledScanService;
  /** Injected for tests; defaults to wall clock. */
  now?: () => Date;
  /** Poll interval (ms). Default 60s. */
  tickMs?: number;
  /** Feishu POST seam (injected in tests). */
  feishuSender?: FeishuSender;
  /** Default Feishu webhook used when a schedule omits its own. */
  defaultFeishuWebhook?: string;
  log?: (line: string) => void;
}

/**
 * Fires each enabled {@link ScheduleConfig} once per day at/after its
 * `timeOfDay` (in its timezone): runs the daily scan and delivers the digest.
 * A minute-granularity poll drives it; firing is deduped by the calendar date
 * of `lastRunAt`, so a missed tick still runs (once) later the same day. The
 * timer is started ONLY while at least one enabled config exists — call
 * {@link refresh} after any config mutation.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  /** Ids currently being scanned — guards against concurrent runs of the same
   * schedule (and auto-clears on restart, so a crash can't leave it stuck). */
  private readonly running = new Set<string>();
  private readonly now: () => Date;
  private readonly tickMs: number;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.tickMs = deps.tickMs ?? 60_000;
    this.log = deps.log ?? (() => {});
  }

  /** Start/stop the poll timer to match whether any enabled config exists. */
  async refresh(): Promise<void> {
    const anyEnabled = (await this.deps.store.list()).some((s) => s.enabled);
    if (anyEnabled && !this.timer) {
      this.timer = setInterval(() => {
        void this.tick().catch((err) =>
          this.log(`scheduler tick failed: ${(err as Error).message}`),
        );
      }, this.tickMs);
      this.timer.unref?.();
      this.log("scheduler started");
    } else if (!anyEnabled && this.timer) {
      this.stop();
      this.log("scheduler stopped (no enabled schedules)");
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One poll: fire every enabled config that is due and not yet run today. */
  async tick(): Promise<void> {
    const now = this.now();
    for (const config of await this.deps.store.list()) {
      if (!config.enabled) continue;
      if (shouldFire(config, now)) {
        await this.runConfig(config, now);
      }
    }
  }

  /**
   * Run one schedule now: scan → deliver → record outcome. Used by the timer
   * and the manual "run now" endpoint. Never throws; records the error on the
   * config so the UI can show it.
   */
  async runConfig(config: ScheduleConfig, now: Date = this.now()): Promise<ScanResult | null> {
    // Don't start a second run of the same schedule while one is in flight.
    if (this.running.has(config.id)) {
      this.log(`schedule ${config.id} already running; skipped`);
      return null;
    }
    this.running.add(config.id);
    // Mark running + stamp lastRunAt up-front (so a long run isn't re-fired by
    // the next tick, and the UI can show "running").
    await this.deps.store.update(config.id, { running: true, lastRunAt: now.toISOString() });
    try {
      const result = await this.deps.scan.scan(config, now);
      const delivery = await this.deliver(config, result);
      const summary =
        `ok: ${result.totalFindings} finding(s) across ${result.branches.length} branch(es)` +
        (delivery.ok ? "" : `; delivery failed: ${delivery.error}`);
      await this.deps.store.update(config.id, { running: false, lastResult: summary });
      this.log(`schedule ${config.id} (${config.repoFullName}) ${summary}`);
      return result;
    } catch (err) {
      const msg = (err as Error).message;
      await this.deps.store.update(config.id, { running: false, lastResult: `error: ${msg}` });
      this.log(`schedule ${config.id} failed: ${msg}`);
      return null;
    } finally {
      this.running.delete(config.id);
    }
  }

  /** Whether a run is currently in progress for this schedule. */
  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  /**
   * Clear any stale `running` flags left by a crash/restart (the in-memory set
   * is empty after a restart, so a persisted `running:true` can only be stale).
   * Call once at startup.
   */
  async reconcileRunning(): Promise<void> {
    for (const s of await this.deps.store.list()) {
      if (s.running && !this.running.has(s.id)) {
        await this.deps.store.update(s.id, {
          running: false,
          lastResult: "中断（服务重启）",
        });
      }
    }
  }

  private deliver(
    config: ScheduleConfig,
    result: ScanResult,
  ): Promise<{ ok: boolean; error?: string }> {
    if (config.delivery.type === "feishu") {
      // Per-schedule webhook wins; otherwise fall back to the deploy-wide default.
      const url = config.delivery.webhookUrl || this.deps.defaultFeishuWebhook || "";
      if (!url) {
        return Promise.resolve({
          ok: false,
          error: "no Feishu webhook configured (set delivery.webhookUrl or FEISHU_WEBHOOK_URL)",
        });
      }
      return deliverFeishu(url, result, this.deps.feishuSender);
    }
    return Promise.resolve({ ok: false, error: `unsupported delivery: ${config.delivery.type}` });
  }
}

/**
 * Whether a config is due: it's at/after its scheduled minute today (in its
 * timezone) and hasn't already run today. Pure — unit-testable with a fixed now.
 */
export function shouldFire(config: ScheduleConfig, now: Date): boolean {
  const tz = config.timezone || "UTC";
  const scheduled = parseTimeOfDay(config.timeOfDay);
  if (scheduled === null) return false;
  if (tzMinutes(tz, now) < scheduled) return false;
  const today = tzDate(tz, now);
  const lastDay = config.lastRunAt ? tzDate(tz, new Date(config.lastRunAt)) : null;
  return lastDay !== today;
}
