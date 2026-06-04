import { SqlRepository } from "../src/persistence/sql/sql-repository.js";
import { PgliteSqlClient } from "./pglite-sql-client.js";
import { fixedClock, runRepositoryContract, seqIdGen } from "./repository-contract.js";

/**
 * Runs the SAME repository contract as Memory/File — but against a REAL
 * Postgres engine (PGlite/WASM) via {@link SqlRepository}. This objectively
 * closes the "live SQL persistence" gap: real migrations, real $1 placeholders,
 * real constraints, create/read/state-transition all green — with no daemon,
 * native build or network.
 *
 * Each contract case gets a fresh in-memory Postgres for isolation; repo.init()
 * runs the migrations.
 */
runRepositoryContract("SqlRepository(pglite/postgres)", async () => {
  const client = new PgliteSqlClient();
  const repo = new SqlRepository(client, { clock: fixedClock(), idGen: seqIdGen() });
  await repo.init();
  return repo;
});
