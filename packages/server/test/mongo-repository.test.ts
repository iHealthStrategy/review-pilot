import { MongoRepository } from "../src/persistence/mongo/mongo-repository.js";
import { FakeMongoStore } from "./fake-mongo-store.js";
import { fixedClock, runRepositoryContract, seqIdGen } from "./repository-contract.js";

/**
 * Runs the SAME repository contract as Memory/File/SQL — but against
 * {@link MongoRepository} over an in-memory {@link FakeMongoStore} that
 * faithfully implements the port's Mongo-semantics subset (equality filters,
 * `$set`/`$push`/`$inc`, sorted finds, atomic `findOneAndUpdate`, unique
 * indexes). This closes the "live Mongo persistence" gap with no `mongodb`
 * package and no daemon, exactly as PGlite does for the SQL backend.
 */
runRepositoryContract("MongoRepository(fake)", async () => {
  const repo = new MongoRepository(new FakeMongoStore(), {
    clock: fixedClock(),
    idGen: seqIdGen(),
  });
  await repo.init();
  return repo;
});
