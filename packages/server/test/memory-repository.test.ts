import { MemoryRepository } from "../src/persistence/memory-repository.js";
import {
  fixedClock,
  runRepositoryContract,
  seqIdGen,
} from "./repository-contract.js";

runRepositoryContract("MemoryRepository", async () => {
  const repo = new MemoryRepository({ clock: fixedClock(), idGen: seqIdGen() });
  await repo.init();
  return repo;
});
