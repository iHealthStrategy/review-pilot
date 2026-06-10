import type { Platform, ReviewEngineKind } from "../domain/entities.js";

/** Where a scheduled scan's results are pushed. (Email is a later addition.) */
export type DeliveryConfig = {
  type: "feishu";
  /** Feishu (Lark) custom-bot incoming webhook URL. */
  webhookUrl: string;
};

/**
 * A daily scheduled scan of a GitHub repository: at `timeOfDay` (in `timezone`)
 * the service reviews the day's changes on the selected branches and pushes a
 * digest to the configured delivery target. Persisted in the lightweight
 * {@link ScheduleStore} — independent of the main review persistence.
 */
export interface ScheduleConfig {
  readonly id: string;
  readonly name: string;
  readonly platform: Platform;
  /** `owner/repo` path. */
  readonly repoFullName: string;
  /** Clone URL; derived from `repoFullName` when empty. */
  readonly cloneUrl: string;
  /** Branches to scan; empty = all remote branches. */
  readonly branches: string[];
  /** Daily fire time, "HH:MM" 24h. */
  readonly timeOfDay: string;
  /** IANA timezone the `timeOfDay` is evaluated in. */
  readonly timezone: string;
  /**
   * How far back to look for commits, in hours (default 24). The scan reviews
   * commits authored within the last `lookbackHours` from the run time — a
   * rolling window, NOT "since midnight", so a run shortly after midnight still
   * covers the previous day's work.
   */
  readonly lookbackHours: number;
  /** Engine override; falls back to the server default when empty. */
  readonly engine?: ReviewEngineKind;
  readonly delivery: DeliveryConfig;
  /** When false, the scheduler skips this config. */
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** ISO timestamp of the last successful run start (dedup within a day). */
  readonly lastRunAt?: string;
  /** One-line summary of the last run (ok/skip/error) for the UI. */
  readonly lastResult?: string;
}

export interface CreateScheduleInput {
  name: string;
  platform: Platform;
  repoFullName: string;
  cloneUrl?: string;
  branches?: string[];
  timeOfDay: string;
  timezone?: string;
  lookbackHours?: number;
  engine?: ReviewEngineKind;
  delivery: DeliveryConfig;
  enabled?: boolean;
}

/** Mutable fields of a schedule (all optional — partial update). */
export interface UpdateScheduleInput {
  name?: string;
  repoFullName?: string;
  cloneUrl?: string;
  branches?: string[];
  timeOfDay?: string;
  timezone?: string;
  lookbackHours?: number;
  engine?: ReviewEngineKind | null;
  delivery?: DeliveryConfig;
  enabled?: boolean;
  lastRunAt?: string;
  lastResult?: string;
}

/**
 * Lightweight persistence for scheduled-scan configs, intentionally separate
 * from the main {@link Repository} so adding this feature doesn't disturb the
 * review persistence contract or its backends.
 */
export interface ScheduleStore {
  init(): Promise<void>;
  list(): Promise<ScheduleConfig[]>;
  get(id: string): Promise<ScheduleConfig | null>;
  create(input: CreateScheduleInput): Promise<ScheduleConfig>;
  update(id: string, patch: UpdateScheduleInput): Promise<ScheduleConfig>;
  remove(id: string): Promise<void>;
  close(): Promise<void>;
}

export class ScheduleNotFoundError extends Error {
  constructor(id: string) {
    super(`schedule not found: ${id}`);
    this.name = "ScheduleNotFoundError";
  }
}
