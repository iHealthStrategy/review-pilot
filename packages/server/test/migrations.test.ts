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
    "skill_usage",
    "rulesets",
  ]) {
    assert.match(ddl, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
  // PR dedupe is enforced at the schema level.
  assert.match(ddl, /UNIQUE \(repo_id, number\)/);
  // 0006 adds public handles + structured rules.
  assert.match(ddl, /ALTER TABLE users ADD COLUMN handle\b/);
  assert.match(ddl, /ALTER TABLE rulesets ADD COLUMN owner_handle\b/);
  assert.match(ddl, /ALTER TABLE rulesets ADD COLUMN rules\b/);
  // 0007 scopes rulesets to a project.
  assert.match(ddl, /ALTER TABLE rulesets ADD COLUMN project\b/);
  assert.match(ddl, /ALTER TABLE rulesets ADD COLUMN project_label\b/);
  // 0008 adds per-user skill-usage tracking.
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS skill_usage\b/);
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
    "0005_rulesets",
    "0006_handles_and_rules",
    "0007_ruleset_project",
    "0008_skill_usage",
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
    { id: "0005_rulesets" },
    { id: "0006_handles_and_rules" },
    { id: "0007_ruleset_project" },
    { id: "0008_skill_usage" },
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
