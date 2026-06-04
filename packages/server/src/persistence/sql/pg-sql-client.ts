import pg from "pg";
import type { SqlClient, SqlDialect } from "./sql-client.js";

/**
 * Postgres-backed {@link SqlClient} using the pure-JS `pg` driver (no native
 * build). This is the live binding for `DB_DRIVER=postgres`: inject it into
 * {@link SqlRepository} via the repository factory. The DDL/queries are already
 * dialect-aware ($1 placeholders), so this adapter only translates the port to
 * a connection pool.
 */
export class PgSqlClient implements SqlClient {
  readonly dialect: SqlDialect = "postgres";
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  async exec(sql: string): Promise<void> {
    // Simple-query protocol: supports multiple statements (used for migrations).
    await this.pool.query(sql);
  }

  async run(sql: string, params: readonly unknown[] = []): Promise<void> {
    await this.pool.query(sql, params as unknown[]);
  }

  async all<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    const res = await this.pool.query(sql, params as unknown[]);
    return res.rows as T[];
  }

  async get<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T | null> {
    const res = await this.pool.query(sql, params as unknown[]);
    return (res.rows[0] as T) ?? null;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
