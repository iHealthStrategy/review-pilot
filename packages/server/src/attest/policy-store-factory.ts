import type { AppConfig } from "../config.js";
import { MongoDbStore } from "../persistence/mongo/mongo-client.js";
import { FileAttestPolicyStore, type AttestPolicyStore } from "./policy-store.js";
import { MongoAttestPolicyStore } from "./mongo-policy-store.js";

/**
 * Build the {@link AttestPolicyStore}. Mirrors the schedule-store choice: the
 * `mongo` driver gets a DB-backed store (the policy survives a stateless
 * redeploy); every other driver uses the lightweight JSON-file store (put the
 * file on a volume to persist). The env values seed the first run.
 */
export function createAttestPolicyStore(config: AppConfig): AttestPolicyStore {
  const defaults = {
    enforce: config.attest.enforce,
    blockSeverity: config.attest.blockSeverity,
  };
  if (config.db.driver === "mongo" && config.db.mongoUri) {
    return new MongoAttestPolicyStore(
      new MongoDbStore(config.db.mongoUri, config.db.mongoDb),
      { defaults },
    );
  }
  return new FileAttestPolicyStore({ defaults, filePath: config.attest.storeFile });
}
