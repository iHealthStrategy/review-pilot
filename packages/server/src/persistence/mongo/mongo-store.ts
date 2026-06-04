/**
 * Minimal MongoDB driver port.
 *
 * Like the {@link ../sql/sql-client.ts SqlClient} port, this exposes only the
 * narrow, well-defined subset of Mongo semantics that {@link MongoRepository}
 * actually needs — equality filters, `$set`/`$push`/`$inc` updates, sorted
 * finds and an atomic `findOneAndUpdate`. That subset is small enough to be
 * fully reproduced by an in-memory fake (so the repository contract runs with
 * no daemon) yet a strict subset of the real driver (so the live adapter is a
 * thin pass-through). The repository carries no dependency on the `mongodb`
 * package; the live adapter loads it lazily.
 */

/** Equality-only filter: every field must match exactly (AND-combined). */
export type MongoFilter = Record<string, string | number>;

/** The update operators the repository relies on. */
export interface MongoUpdate {
  /** Replace these fields. */
  $set?: Record<string, unknown>;
  /** Append a value to an array field. */
  $push?: Record<string, unknown>;
  /** Increment a numeric field by the given delta. */
  $inc?: Record<string, number>;
}

export interface FindOptions {
  /** Sort by a single field before applying the limit. */
  sort?: { field: string; dir: 1 | -1 };
  limit?: number;
}

/** A stored document. The repository stores plain entity shapes (camelCase). */
export type MongoDoc = Record<string, unknown>;

export interface MongoCollection {
  insertOne(doc: MongoDoc): Promise<void>;
  insertMany(docs: MongoDoc[]): Promise<void>;
  findOne<T = MongoDoc>(filter: MongoFilter): Promise<T | null>;
  find<T = MongoDoc>(filter: MongoFilter, opts?: FindOptions): Promise<T[]>;
  /** Apply an update to the first matching doc; returns rows matched. */
  updateOne(filter: MongoFilter, update: MongoUpdate): Promise<{ matched: number }>;
  /**
   * Atomically find one matching doc (honouring `sort`), apply the update, and
   * return the document AFTER the update — the primitive that makes job
   * claiming safe across competing stateless workers. Returns null if nothing
   * matched.
   */
  findOneAndUpdate<T = MongoDoc>(
    filter: MongoFilter,
    update: MongoUpdate,
    opts?: { sort?: { field: string; dir: 1 | -1 } },
  ): Promise<T | null>;
  deleteOne(filter: MongoFilter): Promise<{ deleted: number }>;
  deleteMany(filter: MongoFilter): Promise<{ deleted: number }>;
  /** Idempotently ensure an index exists (called once at init). */
  createIndex(spec: Record<string, 1 | -1>, opts?: { unique?: boolean }): Promise<void>;
}

export interface MongoStore {
  collection(name: string): MongoCollection;
  close(): Promise<void>;
}
