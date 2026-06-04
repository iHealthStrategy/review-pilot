import type { SqlClient, SqlDialect } from "../src/persistence/sql/sql-client.js";

interface Recorded {
  sql: string;
  params: unknown[];
}

/**
 * Recording, canned-response {@link SqlClient} fake. It does not interpret SQL
 * — it records every statement and returns queued rows — which is exactly what
 * unit tests need to assert the SqlRepository emits the right SQL, parameters
 * and dialect placeholders without binding a native database driver.
 */
export class FakeSqlClient implements SqlClient {
  readonly dialect: SqlDialect;
  readonly execs: string[] = [];
  readonly runs: Recorded[] = [];
  readonly queries: Recorded[] = [];
  private readonly getQueue: unknown[] = [];
  private readonly allQueue: unknown[][] = [];
  closed = false;

  constructor(dialect: SqlDialect) {
    this.dialect = dialect;
  }

  /** Queue the next `get()` response (FIFO). */
  queueGet(row: unknown): this {
    this.getQueue.push(row);
    return this;
  }

  /** Queue the next `all()` response (FIFO). */
  queueAll(rows: unknown[]): this {
    this.allQueue.push(rows);
    return this;
  }

  async exec(sql: string): Promise<void> {
    this.execs.push(sql);
  }

  async run(sql: string, params: readonly unknown[] = []): Promise<void> {
    this.runs.push({ sql, params: [...params] });
  }

  async all<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    this.queries.push({ sql, params: [...params] });
    return (this.allQueue.shift() ?? []) as T[];
  }

  async get<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T | null> {
    this.queries.push({ sql, params: [...params] });
    return (this.getQueue.length ? this.getQueue.shift() : null) as T | null;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
