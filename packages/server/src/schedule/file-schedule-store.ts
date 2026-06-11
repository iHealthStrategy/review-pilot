import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  CreateScheduleInput,
  ScheduleConfig,
  ScheduleStore,
  UpdateScheduleInput,
} from "./schedule.js";
import { ScheduleNotFoundError } from "./schedule.js";

export interface FileScheduleStoreOptions {
  /** JSON file to persist to; omit for a pure in-memory store. */
  filePath?: string;
  clock?: () => string;
  idGen?: () => string;
}

/**
 * Lightweight {@link ScheduleStore} backed by a JSON file (or pure memory when
 * no path is given). Loads once on {@link init} and rewrites the whole file on
 * each mutation — fine for the handful of schedule configs a deployment has.
 */
export class FileScheduleStore implements ScheduleStore {
  private readonly clock: () => string;
  private readonly idGen: () => string;
  private readonly filePath?: string;
  private data: ScheduleConfig[] = [];

  constructor(opts: FileScheduleStoreOptions = {}) {
    this.clock = opts.clock ?? (() => new Date().toISOString());
    this.idGen = opts.idGen ?? (() => `sch_${randomUUID()}`);
    if (opts.filePath) this.filePath = opts.filePath;
  }

  async init(): Promise<void> {
    if (!this.filePath) return;
    try {
      const text = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) this.data = parsed as ScheduleConfig[];
    } catch (err) {
      // Missing file → start empty. A corrupt file should surface, not be lost.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  async list(): Promise<ScheduleConfig[]> {
    return this.data.map((s) => ({ ...s }));
  }

  async get(id: string): Promise<ScheduleConfig | null> {
    const found = this.data.find((s) => s.id === id);
    return found ? { ...found } : null;
  }

  async create(input: CreateScheduleInput): Promise<ScheduleConfig> {
    const now = this.clock();
    const config: ScheduleConfig = {
      id: this.idGen(),
      name: input.name,
      platform: input.platform,
      repoFullName: input.repoFullName,
      cloneUrl: input.cloneUrl ?? deriveCloneUrl(input.platform, input.repoFullName),
      branches: input.branches ?? [],
      timeOfDay: input.timeOfDay,
      timezone: input.timezone ?? "UTC",
      lookbackHours: input.lookbackHours && input.lookbackHours > 0 ? input.lookbackHours : 24,
      ...(input.reviewFocus ? { reviewFocus: input.reviewFocus } : {}),
      ...(input.engine ? { engine: input.engine } : {}),
      delivery: input.delivery,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };
    this.data.push(config);
    await this.persist();
    return { ...config };
  }

  async update(id: string, patch: UpdateScheduleInput): Promise<ScheduleConfig> {
    const idx = this.data.findIndex((s) => s.id === id);
    if (idx < 0) throw new ScheduleNotFoundError(id);
    const prev = this.data[idx]!;
    const next: ScheduleConfig = {
      ...prev,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.repoFullName !== undefined ? { repoFullName: patch.repoFullName } : {}),
      ...(patch.cloneUrl !== undefined ? { cloneUrl: patch.cloneUrl } : {}),
      ...(patch.branches !== undefined ? { branches: patch.branches } : {}),
      ...(patch.timeOfDay !== undefined ? { timeOfDay: patch.timeOfDay } : {}),
      ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
      ...(patch.lookbackHours !== undefined ? { lookbackHours: patch.lookbackHours } : {}),
      ...(patch.reviewFocus !== undefined ? { reviewFocus: patch.reviewFocus } : {}),
      ...(patch.delivery !== undefined ? { delivery: patch.delivery } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.running !== undefined ? { running: patch.running } : {}),
      ...(patch.lastRunAt !== undefined ? { lastRunAt: patch.lastRunAt } : {}),
      ...(patch.lastResult !== undefined ? { lastResult: patch.lastResult } : {}),
      ...(patch.lastScan !== undefined ? { lastScan: patch.lastScan } : {}),
      updatedAt: this.clock(),
    };
    // engine: null clears the override, a value sets it, undefined leaves it.
    if (patch.engine === null) delete (next as { engine?: unknown }).engine;
    else if (patch.engine !== undefined) (next as { engine?: unknown }).engine = patch.engine;
    this.data[idx] = next;
    await this.persist();
    return { ...next };
  }

  async remove(id: string): Promise<void> {
    const before = this.data.length;
    this.data = this.data.filter((s) => s.id !== id);
    if (this.data.length === before) throw new ScheduleNotFoundError(id);
    await this.persist();
  }

  async close(): Promise<void> {
    /* nothing to release */
  }

  private async persist(): Promise<void> {
    if (!this.filePath) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.data, null, 2), "utf8");
  }
}

function deriveCloneUrl(platform: string, fullName: string): string {
  const host = platform === "gitlab" ? "https://gitlab.com" : "https://github.com";
  return `${host}/${fullName}.git`;
}
