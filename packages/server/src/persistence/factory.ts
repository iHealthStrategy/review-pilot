import type { AppConfig } from "../config.js";
import { FileRepository } from "./file-repository.js";
import { MemoryRepository } from "./memory-repository.js";
import { MongoDbStore } from "./mongo/mongo-client.js";
import { MongoRepository } from "./mongo/mongo-repository.js";
import type { MongoStore } from "./mongo/mongo-store.js";
import type { Clock, IdGen, Repository } from "./repository.js";
import { PgSqlClient } from "./sql/pg-sql-client.js";
import type { SqlClient } from "./sql/sql-client.js";
import { SqlRepository } from "./sql/sql-repository.js";

export interface RepositoryDeps {
  clock?: Clock;
  idGen?: IdGen;
  /**
   * Live SQL driver for `sqlite`/`postgres` drivers. Injected by the caller so
   * the persistence layer carries no native dependency. When omitted for a SQL
   * driver, construction fails fast with an actionable error.
   */
  sqlClient?: SqlClient;
  /** Live Mongo store for the `mongo` driver; injected as a fake in tests. */
  mongoStore?: MongoStore;
  /** Override the file path for the `mock` driver's optional durability. */
  filePath?: string;
}

/**
 * Build the configured {@link Repository}. The `mock` driver is in-memory by
 * default (credential-free, used by the test suite); pass `filePath` to make
 * it durable via {@link FileRepository}. SQL drivers require an injected
 * {@link SqlClient} until the native driver binding lands.
 */
export function createRepository(
  config: AppConfig,
  deps: RepositoryDeps = {},
): Repository {
  const { clock, idGen } = deps;
  switch (config.db.driver) {
    case "mock":
      return deps.filePath
        ? new FileRepository(deps.filePath, { clock, idGen })
        : new MemoryRepository({ clock, idGen });
    case "postgres": {
      // Prefer an injected client (tests); otherwise build the pg-backed one
      // from DATABASE_URL. `repo.init()` runs migrations on first use.
      const client =
        deps.sqlClient ??
        (config.db.databaseUrl
          ? new PgSqlClient(config.db.databaseUrl)
          : undefined);
      if (!client) {
        throw new Error(
          "DB_DRIVER=postgres requires DATABASE_URL (or an injected SqlClient).",
        );
      }
      return new SqlRepository(client, { clock, idGen });
    }
    case "mongo": {
      // Prefer an injected store (tests); otherwise build the live one from
      // MONGODB_URI. `repo.init()` creates indexes on first use.
      const store =
        deps.mongoStore ??
        (config.db.mongoUri
          ? new MongoDbStore(config.db.mongoUri, config.db.mongoDb)
          : undefined);
      if (!store) {
        throw new Error(
          "DB_DRIVER=mongo requires MONGODB_URI (or an injected MongoStore).",
        );
      }
      return new MongoRepository(store, { clock, idGen });
    }
    case "sqlite":
      if (!deps.sqlClient) {
        throw new Error(
          "DB_DRIVER=sqlite requires an injected SqlClient. On Node >= 22.5 a " +
            "node:sqlite-backed client can be wired; otherwise use DB_DRIVER=postgres " +
            "(DATABASE_URL) or DB_DRIVER=mock for credential-free runs.",
        );
      }
      return new SqlRepository(deps.sqlClient, { clock, idGen });
    default: {
      const exhaustive: never = config.db.driver;
      throw new Error(`Unsupported DB_DRIVER: ${String(exhaustive)}`);
    }
  }
}
