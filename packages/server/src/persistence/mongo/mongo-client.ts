import type {
  FindOptions,
  MongoCollection,
  MongoDoc,
  MongoFilter,
  MongoStore,
  MongoUpdate,
} from "./mongo-store.js";

/**
 * Live {@link MongoStore} backed by the official `mongodb` driver.
 *
 * The driver is loaded with a dynamic `import()` of a non-literal specifier so
 * neither `tsc` (build/lint) nor the test suite needs the `mongodb` package
 * installed — only the production runtime does (it is installed in the Docker
 * runtime image). Connection is lazy: the first collection operation awaits a
 * single cached connect, so the synchronous {@link MongoStore.collection} stays
 * a thin pass-through. The port's filter/update subset is a strict subset of
 * the driver's API, so this adapter forwards calls almost verbatim.
 */
export class MongoDbStore implements MongoStore {
  private readonly ready: Promise<MongoDbHandle>;

  constructor(uri: string, dbName: string) {
    this.ready = connect(uri, dbName);
  }

  collection(name: string): MongoCollection {
    return new MongoDbCollection(this.ready, name);
  }

  async close(): Promise<void> {
    const handle = await this.ready;
    await handle.client.close();
  }
}

interface MongoDbHandle {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
}

async function connect(uri: string, dbName: string): Promise<MongoDbHandle> {
  // Non-literal specifier: TypeScript does not statically resolve it, so the
  // package is only required at runtime.
  const specifier = "mongodb";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import(specifier);
  const MongoClient = mod.MongoClient ?? mod.default?.MongoClient;
  const client = new MongoClient(uri);
  await client.connect();
  return { client, db: client.db(dbName) };
}

class MongoDbCollection implements MongoCollection {
  constructor(
    private readonly ready: Promise<MongoDbHandle>,
    private readonly name: string,
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async col(): Promise<any> {
    const { db } = await this.ready;
    return db.collection(this.name);
  }

  async insertOne(doc: MongoDoc): Promise<void> {
    await (await this.col()).insertOne(doc);
  }

  async insertMany(docs: MongoDoc[]): Promise<void> {
    await (await this.col()).insertMany(docs);
  }

  async findOne<T = MongoDoc>(filter: MongoFilter): Promise<T | null> {
    const doc = await (await this.col()).findOne(filter, { projection: { _id: 0 } });
    return (doc as T) ?? null;
  }

  async find<T = MongoDoc>(filter: MongoFilter, opts?: FindOptions): Promise<T[]> {
    let cursor = (await this.col()).find(filter, { projection: { _id: 0 } });
    if (opts?.sort) cursor = cursor.sort({ [opts.sort.field]: opts.sort.dir });
    if (opts?.limit) cursor = cursor.limit(opts.limit);
    return (await cursor.toArray()) as T[];
  }

  async updateOne(
    filter: MongoFilter,
    update: MongoUpdate,
  ): Promise<{ matched: number }> {
    const res = await (await this.col()).updateOne(filter, update);
    return { matched: res.matchedCount ?? 0 };
  }

  async findOneAndUpdate<T = MongoDoc>(
    filter: MongoFilter,
    update: MongoUpdate,
    opts?: { sort?: { field: string; dir: 1 | -1 } },
  ): Promise<T | null> {
    const driverOpts: Record<string, unknown> = {
      returnDocument: "after",
      projection: { _id: 0 },
    };
    if (opts?.sort) driverOpts.sort = { [opts.sort.field]: opts.sort.dir };
    const res = await (await this.col()).findOneAndUpdate(filter, update, driverOpts);
    // Driver v5+ returns the document directly; v4 wraps it in `{ value }`.
    const doc = res && typeof res === "object" && "value" in res ? res.value : res;
    return (doc as T) ?? null;
  }

  async deleteOne(filter: MongoFilter): Promise<{ deleted: number }> {
    const res = await (await this.col()).deleteOne(filter);
    return { deleted: res.deletedCount ?? 0 };
  }

  async deleteMany(filter: MongoFilter): Promise<{ deleted: number }> {
    const res = await (await this.col()).deleteMany(filter);
    return { deleted: res.deletedCount ?? 0 };
  }

  async createIndex(
    spec: Record<string, 1 | -1>,
    opts?: { unique?: boolean },
  ): Promise<void> {
    await (await this.col()).createIndex(spec, opts ?? {});
  }
}
