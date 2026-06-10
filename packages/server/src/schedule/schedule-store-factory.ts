import type { AppConfig } from "../config.js";
import { MongoDbStore } from "../persistence/mongo/mongo-client.js";
import { FileScheduleStore } from "./file-schedule-store.js";
import { MongoScheduleStore } from "./mongo-schedule-store.js";
import type { ScheduleStore } from "./schedule.js";

/**
 * Build the {@link ScheduleStore}. Mirrors the main persistence choice: the
 * `mongo` driver gets a DB-backed store (configs survive a stateless redeploy);
 * every other driver uses the lightweight JSON-file store (put the file on a
 * volume to persist). Pure in-memory if no file path is configured.
 */
export function createScheduleStore(config: AppConfig): ScheduleStore {
  if (config.db.driver === "mongo" && config.db.mongoUri) {
    return new MongoScheduleStore(
      new MongoDbStore(config.db.mongoUri, config.db.mongoDb),
    );
  }
  return new FileScheduleStore({ filePath: config.schedule.storeFile });
}
