import { after, test } from "node:test";
import { SqlRepository } from "../src/persistence/sql/sql-repository.js";
import { PgSqlClient } from "../src/persistence/sql/pg-sql-client.js";
import type { SqlClient } from "../src/persistence/sql/sql-client.js";
import { fixedClock, runRepositoryContract, seqIdGen } from "./repository-contract.js";

/**
 * Runs the SAME repository contract as Memory/File — but against a REAL
 * Postgres via {@link PgSqlClient} — closing the "live SQL persistence" gap.
 *
 * It only runs when TEST_DATABASE_URL is set (e.g. the docker-compose postgres
 * profile, or `docker run postgres`), so the default offline `npm test` stays
 * green. Each contract case truncates all tables for isolation; migrations run
 * idempotently via repo.init().
 */
const url = process.env.TEST_DATABASE_URL;

if (!url) {
  test("SqlRepository(pg) contract — skipped (set TEST_DATABASE_URL)", { skip: true }, () => {});
} else {
  const real = new PgSqlClient(url);
  // A non-closing facade: the contract calls repo.close() after every case,
  // but we keep the shared pool open and end it once in `after`.
  const shared: SqlClient = {
    dialect: real.dialect,
    exec: (sql) => real.exec(sql),
    run: (sql, params) => real.run(sql, params),
    all: (sql, params) => real.all(sql, params),
    get: (sql, params) => real.get(sql, params),
    close: async () => {},
  };

  after(async () => {
    await real.close();
  });

  runRepositoryContract("SqlRepository(pg)", async () => {
    const repo = new SqlRepository(shared, { clock: fixedClock(), idGen: seqIdGen() });
    await repo.init(); // idempotent migrations (CREATE TABLE IF NOT EXISTS)
    await shared.exec(
      "TRUNCATE findings, review_jobs, pull_requests, repos, projects RESTART IDENTITY CASCADE",
    );
    return repo;
  });
}
