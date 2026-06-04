import type {
  FindOptions,
  MongoCollection,
  MongoDoc,
  MongoFilter,
  MongoStore,
  MongoUpdate,
} from "../src/persistence/mongo/mongo-store.js";

/**
 * In-memory {@link MongoStore} that faithfully reproduces the port's
 * documented subset of Mongo semantics — equality filters, `$set`/`$push`/
 * `$inc`, sorted/limited finds, atomic `findOneAndUpdate`, and unique-index
 * enforcement. It lets the full repository contract run against
 * {@link MongoRepository} with no `mongodb` package and no daemon, exactly as
 * PGlite does for the SQL backend. JS is single-threaded, so
 * `findOneAndUpdate` is genuinely atomic here.
 */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function matches(doc: MongoDoc, filter: MongoFilter): boolean {
  return Object.entries(filter).every(([k, v]) => doc[k] === v);
}

interface IndexSpec {
  fields: string[];
  unique: boolean;
}

class FakeCollection implements MongoCollection {
  private readonly docs: MongoDoc[] = [];
  private readonly indexes: IndexSpec[] = [];

  async createIndex(
    spec: Record<string, 1 | -1>,
    opts?: { unique?: boolean },
  ): Promise<void> {
    this.indexes.push({ fields: Object.keys(spec), unique: opts?.unique ?? false });
  }

  private assertUnique(doc: MongoDoc): void {
    for (const idx of this.indexes) {
      if (!idx.unique) continue;
      const dup = this.docs.some((d) =>
        idx.fields.every((f) => d[f] === doc[f]),
      );
      if (dup) {
        throw new Error(
          `duplicate key for unique index on ${idx.fields.join(",")}`,
        );
      }
    }
  }

  async insertOne(doc: MongoDoc): Promise<void> {
    this.assertUnique(doc);
    this.docs.push(clone(doc));
  }

  async insertMany(docs: MongoDoc[]): Promise<void> {
    for (const d of docs) await this.insertOne(d);
  }

  async findOne<T = MongoDoc>(filter: MongoFilter): Promise<T | null> {
    const found = this.docs.find((d) => matches(d, filter));
    return found ? (clone(found) as T) : null;
  }

  async find<T = MongoDoc>(filter: MongoFilter, opts?: FindOptions): Promise<T[]> {
    let result = this.docs.filter((d) => matches(d, filter));
    if (opts?.sort) {
      const { field, dir } = opts.sort;
      result = [...result].sort((a, b) => {
        const av = a[field] as string | number;
        const bv = b[field] as string | number;
        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
        return 0;
      });
    }
    if (opts?.limit) result = result.slice(0, opts.limit);
    return result.map((d) => clone(d) as T);
  }

  private apply(doc: MongoDoc, update: MongoUpdate): void {
    if (update.$set) Object.assign(doc, update.$set);
    if (update.$inc) {
      for (const [k, delta] of Object.entries(update.$inc)) {
        doc[k] = ((doc[k] as number) ?? 0) + delta;
      }
    }
    if (update.$push) {
      for (const [k, value] of Object.entries(update.$push)) {
        const arr = Array.isArray(doc[k]) ? (doc[k] as unknown[]) : [];
        arr.push(value);
        doc[k] = arr;
      }
    }
  }

  async updateOne(
    filter: MongoFilter,
    update: MongoUpdate,
  ): Promise<{ matched: number }> {
    const doc = this.docs.find((d) => matches(d, filter));
    if (!doc) return { matched: 0 };
    this.apply(doc, update);
    return { matched: 1 };
  }

  async findOneAndUpdate<T = MongoDoc>(
    filter: MongoFilter,
    update: MongoUpdate,
    opts?: { sort?: { field: string; dir: 1 | -1 } },
  ): Promise<T | null> {
    const candidates = await this.find(filter, opts?.sort ? { sort: opts.sort } : {});
    if (candidates.length === 0) return null;
    const target = this.docs.find((d) => matches(d, { id: candidates[0]!.id as string }));
    if (!target) return null;
    this.apply(target, update);
    return clone(target) as T;
  }

  async deleteOne(filter: MongoFilter): Promise<{ deleted: number }> {
    const i = this.docs.findIndex((d) => matches(d, filter));
    if (i < 0) return { deleted: 0 };
    this.docs.splice(i, 1);
    return { deleted: 1 };
  }

  async deleteMany(filter: MongoFilter): Promise<{ deleted: number }> {
    let deleted = 0;
    for (let i = this.docs.length - 1; i >= 0; i--) {
      if (matches(this.docs[i]!, filter)) {
        this.docs.splice(i, 1);
        deleted++;
      }
    }
    return { deleted };
  }
}

export class FakeMongoStore implements MongoStore {
  private readonly collections = new Map<string, FakeCollection>();
  closed = false;

  collection(name: string): MongoCollection {
    let c = this.collections.get(name);
    if (!c) {
      c = new FakeCollection();
      this.collections.set(name, c);
    }
    return c;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
