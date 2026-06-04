import { PGlite } from "@electric-sql/pglite";
import type { SqlClient, SqlDialect } from "../src/persistence/sql/sql-client.js";

/**
 * {@link SqlClient} backed by PGlite — a REAL Postgres engine compiled to WASM,
 * running in-process with no daemon, no native build and no network. This lets
 * the shared repository contract execute against an actual Postgres dialect
 * ($1 placeholders, real DDL/constraints, TRUNCATE/CASCADE), closing the
 * "live SQL persistence" gap in CI. Production uses {@link PgSqlClient} (pg)
 * against a real Postgres server; both speak the same SqlClient port.
 */
export class PgliteSqlClient implements SqlClient {
  readonly dialect: SqlDialect = "postgres";
  private readonly ready: Promise<PGlite>;

  constructor() {
    this.ready = PGlite.create();
  }

  async exec(sql: string): Promise<void> {
    const db = await this.ready;
    await db.exec(sql);
  }

  async run(sql: string, params: readonly unknown[] = []): Promise<void> {
    const db = await this.ready;
    await db.query(sql, params as unknown[]);
  }

  async all<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    const db = await this.ready;
    const res = await db.query(sql, params as unknown[]);
    return res.rows as T[];
  }

  async get<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T | null> {
    const db = await this.ready;
    const res = await db.query(sql, params as unknown[]);
    return (res.rows[0] as T) ?? null;
  }

  async close(): Promise<void> {
    const db = await this.ready;
    await db.close();
  }
}
