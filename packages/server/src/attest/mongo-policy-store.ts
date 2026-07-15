import type { MongoDoc, MongoStore } from "../persistence/mongo/mongo-store.js";
import type {
  AttestPolicy,
  AttestPolicyDefaults,
  AttestPolicyPatch,
  AttestPolicyStore,
} from "./policy-store.js";

const COLLECTION = "attest_policy";
// A single global document, addressed by a fixed id.
const SINGLETON_ID = "global";

/**
 * MongoDB-backed {@link AttestPolicyStore} — one document in `attest_policy`, so
 * the policy survives a stateless redeploy on the `mongo` driver. Reuses the
 * same {@link MongoStore} port as the main repository.
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
  }

  async get(): Promise<AttestPolicy> {
    const d = await this.col.findOne<MongoDoc>({ id: SINGLETON_ID });
    if (!d) {
      return {
        enforce: this.defaults.enforce,
        blockSeverity: this.defaults.blockSeverity,
        updatedAt: "",
        updatedBy: "default",
      };
    }
    return {
      enforce: (d.enforce as AttestPolicy["enforce"]) ?? this.defaults.enforce,
      blockSeverity: (d.blockSeverity as AttestPolicy["blockSeverity"]) ?? this.defaults.blockSeverity,
      updatedAt: (d.updatedAt as string) ?? "",
      updatedBy: (d.updatedBy as string) ?? "default",
    };
  }

  async set(patch: AttestPolicyPatch, updatedBy: string): Promise<AttestPolicy> {
    const current = await this.get();
    const next: AttestPolicy = {
      enforce: patch.enforce ?? current.enforce,
      blockSeverity: patch.blockSeverity ?? current.blockSeverity,
      updatedAt: this.clock(),
      updatedBy: updatedBy || "unknown",
    };
    // The port has no upsert; emulate it (insert first time, else $set).
    const exists = await this.col.findOne<MongoDoc>({ id: SINGLETON_ID });
    if (exists) {
      await this.col.updateOne({ id: SINGLETON_ID }, { $set: { ...next } });
    } else {
      await this.col.insertOne({ id: SINGLETON_ID, ...next });
    }
    return next;
  }

  async close(): Promise<void> {
    await this.store.close();
  }
}
