import type { MongoDoc, MongoStore } from "../persistence/mongo/mongo-store.js";
import type {
  AttestPolicy,
  AttestPolicyDefaults,
  AttestPolicyPatch,
  AttestPolicyStore,
  EffectiveAttestPolicy,
  ProjectAttestPolicy,
} from "./policy-store.js";

const COLLECTION = "attest_policy";
// The single global default lives under a fixed id; each per-project override
// lives under `project:<key>`. A `scope` field lets us list overrides with the
// port's equality-only filters (no $ne / regex needed).
const GLOBAL_ID = "global";
const projectId = (key: string) => `project:${key}`;

/**
 * MongoDB-backed {@link AttestPolicyStore} — one document per policy in
 * `attest_policy` (the global default plus any per-project overrides), so the
 * policy survives a stateless redeploy on the `mongo` driver. Reuses the same
 * {@link MongoStore} port as the main repository.
 */
export class MongoAttestPolicyStore implements AttestPolicyStore {
  private readonly defaults: AttestPolicyDefaults;
  private readonly clock: () => string;

  constructor(
    private readonly store: MongoStore,
    opts: { defaults: AttestPolicyDefaults; clock?: () => string },
  ) {
    this.defaults = opts.defaults;
    this.clock = opts.clock ?? (() => new Date().toISOString());
  }

  private get col() {
    return this.store.collection(COLLECTION);
  }

  async init(): Promise<void> {
    await this.col.createIndex({ id: 1 }, { unique: true });
    await this.col.createIndex({ scope: 1 });
  }

  /** Fill a stored doc (or nothing) into a full policy from the defaults. */
  private hydrate(d: MongoDoc | null): AttestPolicy {
    return {
      enforce: (d?.enforce as AttestPolicy["enforce"]) ?? this.defaults.enforce,
      blockSeverity: (d?.blockSeverity as AttestPolicy["blockSeverity"]) ?? this.defaults.blockSeverity,
      updatedAt: (d?.updatedAt as string) ?? "",
      updatedBy: (d?.updatedBy as string) ?? "default",
    };
  }

  async getGlobal(): Promise<AttestPolicy> {
    return this.hydrate(await this.col.findOne<MongoDoc>({ id: GLOBAL_ID }));
  }

  async getEffective(project: string): Promise<EffectiveAttestPolicy> {
    const key = project || "";
    if (key) {
      const override = await this.col.findOne<MongoDoc>({ id: projectId(key) });
      if (override) return { ...this.hydrate(override), project: key, source: "project" };
    }
    return { ...(await this.getGlobal()), project: key, source: "global" };
  }

  async set(patch: AttestPolicyPatch, updatedBy: string, project = ""): Promise<AttestPolicy> {
    const key = project || "";
    const id = key ? projectId(key) : GLOBAL_ID;
    // A new override inherits the current global as its starting point.
    const existing = await this.col.findOne<MongoDoc>({ id });
    const base = existing ? this.hydrate(existing) : await this.getGlobal();
    const next: AttestPolicy = {
      enforce: patch.enforce ?? base.enforce,
      blockSeverity: patch.blockSeverity ?? base.blockSeverity,
      updatedAt: this.clock(),
      updatedBy: updatedBy || "unknown",
    };
    if (existing) {
      await this.col.updateOne({ id }, { $set: { ...next } });
    } else {
      await this.col.insertOne({
        id,
        scope: key ? "project" : "global",
        ...(key ? { project: key } : {}),
        ...next,
      });
    }
    return next;
  }

  async listOverrides(): Promise<ProjectAttestPolicy[]> {
    const docs = await this.col.find<MongoDoc>({ scope: "project" });
    return docs.map((d) => ({ ...this.hydrate(d), project: (d.project as string) ?? "" }));
  }

  async deleteOverride(project: string): Promise<void> {
    const key = project || "";
    if (key) await this.col.deleteOne({ id: projectId(key) });
  }

  async close(): Promise<void> {
    await this.store.close();
  }
}
