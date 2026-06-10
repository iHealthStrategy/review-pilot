import { randomUUID } from "node:crypto";
import type { MongoDoc, MongoStore } from "../persistence/mongo/mongo-store.js";
import type {
  CreateScheduleInput,
  ScheduleConfig,
  ScheduleStore,
  UpdateScheduleInput,
} from "./schedule.js";
import { ScheduleNotFoundError } from "./schedule.js";

const COLLECTION = "schedules";

/** Drop `undefined` so optional fields round-trip as absent. */
function clean(doc: MongoDoc): MongoDoc {
  const out: MongoDoc = {};
  for (const [k, v] of Object.entries(doc)) if (v !== undefined) out[k] = v;
  return out;
}

function toConfig(d: MongoDoc): ScheduleConfig {
  const { _id, ...rest } = d as Record<string, unknown> & { _id?: unknown };
  return rest as unknown as ScheduleConfig;
}

/**
 * MongoDB-backed {@link ScheduleStore} (one `schedules` collection). Used for
 * the `mongo` DB driver so scheduled-scan configs survive a stateless
 * redeploy. Reuses the same {@link MongoStore} port as the main repository.
 */
export class MongoScheduleStore implements ScheduleStore {
  private readonly clock: () => string;
  private readonly idGen: () => string;

  constructor(
    private readonly store: MongoStore,
    opts: { clock?: () => string; idGen?: () => string } = {},
  ) {
    this.clock = opts.clock ?? (() => new Date().toISOString());
    this.idGen = opts.idGen ?? (() => `sch_${randomUUID()}`);
  }

  private get col() {
    return this.store.collection(COLLECTION);
  }

  async init(): Promise<void> {
    await this.col.createIndex({ id: 1 }, { unique: true });
  }

  async list(): Promise<ScheduleConfig[]> {
    return (await this.col.find({})).map(toConfig);
  }

  async get(id: string): Promise<ScheduleConfig | null> {
    const d = await this.col.findOne({ id });
    return d ? toConfig(d) : null;
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
      ...(input.engine ? { engine: input.engine } : {}),
      delivery: input.delivery,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };
    await this.col.insertOne(clean(config as unknown as MongoDoc));
    return config;
  }

  async update(id: string, patch: UpdateScheduleInput): Promise<ScheduleConfig> {
    const existing = await this.get(id);
    if (!existing) throw new ScheduleNotFoundError(id);
    const set: Record<string, unknown> = { updatedAt: this.clock() };
    for (const k of [
      "name", "repoFullName", "cloneUrl", "branches", "timeOfDay", "timezone",
      "delivery", "enabled", "lastRunAt", "lastResult",
    ] as const) {
      if (patch[k] !== undefined) set[k] = patch[k];
    }
    if (patch.engine !== undefined && patch.engine !== null) set.engine = patch.engine;
    await this.col.updateOne({ id }, { $set: set });
    // engine: null (clear) — emulate by rewriting without the field.
    if (patch.engine === null && existing.engine) {
      const next = { ...(await this.get(id))! };
      delete (next as { engine?: unknown }).engine;
      await this.col.deleteOne({ id });
      await this.col.insertOne(clean(next as unknown as MongoDoc));
    }
    return (await this.get(id))!;
  }

  async remove(id: string): Promise<void> {
    const res = await this.col.deleteOne({ id });
    if (res.deleted === 0) throw new ScheduleNotFoundError(id);
  }

  async close(): Promise<void> {
    await this.store.close();
  }
}

function deriveCloneUrl(platform: string, fullName: string): string {
  const host = platform === "gitlab" ? "https://gitlab.com" : "https://github.com";
  return `${host}/${fullName}.git`;
}
