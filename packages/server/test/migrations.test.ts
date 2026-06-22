import assert from "node:assert/strict";
import { test } from "node:test";
import { MIGRATIONS, runMigrations } from "../src/persistence/sql/migrations.js";
import { FakeSqlClient } from "./fake-sql-client.js";

test("migrations: DDL creates every entity table", () => {
  const ddl = MIGRATIONS.map((m) => m.up("sqlite")).join("\n");
  for (const table of [
    "projects",
    "repos",
    "pull_requests",
    "review_jobs",
    "findings",
    "repo_insights",
    "users",
    "api_tokens",
    "token_usage",
  ]) {
    assert.match(ddl, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
  // PR dedupe is enforced at the schema level.
  assert.match(ddl, /UNIQUE \(repo_id, number\)/);
});

test("migrations: runner applies all then is idempotent", async () => {
  const client = new FakeSqlClient("sqlite");
  client.queueAll([]); // no migrations applied yet
  const ran = await runMigrations(client);
  assert.deepEqual(ran, [
    "0001_init",
    "0002_repo_insights",
    "0003_users_tokens",
    "0004_token_usage",
  ]);
  // _migrations ledger + each migration body were exec'd.
  assert.ok(client.execs.some((s) => /_migrations/.test(s)));
  assert.ok(client.execs.some((s) => /CREATE TABLE IF NOT EXISTS projects/.test(s)));

  // Second run: ledger reports them already applied → nothing runs.
  client.queueAll([
    { id: "0001_init" },
    { id: "0002_repo_insights" },
    { id: "0003_users_tokens" },
    { id: "0004_token_usage" },
  ]);
  const ran2 = await runMigrations(client);
  assert.deepEqual(ran2, []);
});

test("migrations: postgres ledger insert uses $-placeholders", async () => {
  const client = new FakeSqlClient("postgres");
  client.queueAll([]);
  await runMigrations(client);
  const insert = client.runs.find((r) => /INSERT INTO _migrations/.test(r.sql));
  assert.ok(insert);
  assert.match(insert.sql, /\$1, \$2/);
});
