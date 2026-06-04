/** SQL dialects ReviewPilot's schema targets. */
export type SqlDialect = "sqlite" | "postgres";

/**
 * Minimal SQL driver port. A real backend (better-sqlite3, node:sqlite, pg,
 * ...) is adapted to this interface and injected into {@link SqlRepository},
 * keeping the repository free of any native/heavy dependency. Tests inject a
 * recording fake to assert emitted SQL and parameters.
 */
export interface SqlClient {
  readonly dialect: SqlDialect;
  /** Execute DDL / multi-statement SQL with no parameters. */
  exec(sql: string): Promise<void>;
  /** Execute a parameterised write (INSERT/UPDATE/DELETE). */
  run(sql: string, params?: readonly unknown[]): Promise<void>;
  /** Run a query returning all rows. */
  all<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<T[]>;
  /** Run a query returning the first row or null. */
  get<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<T | null>;
  close(): Promise<void>;
}

/**
 * Positional placeholder for the given 1-based parameter index. SQLite uses
 * `?`; Postgres uses `$1`, `$2`, ... This is the only query-level dialect
 * divergence in the current schema.
 */
export function placeholder(dialect: SqlDialect, index: number): string {
  return dialect === "postgres" ? `$${index}` : "?";
}

/** Build `($1, $2, ...)` / `(?, ?, ...)` for `count` params starting at `from`. */
export function placeholderList(
  dialect: SqlDialect,
  count: number,
  from = 1,
): string {
  return Array.from({ length: count }, (_v, i) =>
    placeholder(dialect, from + i),
  ).join(", ");
}
