import assert from "node:assert/strict";
import { test } from "node:test";
import { InvalidTransitionError } from "../src/domain/state-machine.js";
import { SqlRepository } from "../src/persistence/sql/sql-repository.js";
import { FakeSqlClient } from "./fake-sql-client.js";
import { fixedClock, seqIdGen } from "./repository-contract.js";

function makeRepo(dialect: "sqlite" | "postgres") {
  const client = new FakeSqlClient(dialect);
  const repo = new SqlRepository(client, {
    clock: fixedClock(),
    idGen: seqIdGen(),
  });
  return { client, repo };
}

test("SqlRepository: init runs migrations", async () => {
  const { client, repo } = makeRepo("sqlite");
  client.queueAll([]);
  await repo.init();
  assert.ok(client.execs.some((s) => /CREATE TABLE IF NOT EXISTS findings/.test(s)));
});

test("SqlRepository: createProject emits a 7-param INSERT and serialises engines", async () => {
  const { client, repo } = makeRepo("sqlite");
  const project = await repo.createProject({
    name: "p1",
    platform: "github",
    defaultEngine: "mock",
    enabledEngines: ["mock", "codex"],
  });
  const insert = client.runs.at(-1);
  assert.ok(insert);
  assert.match(insert.sql, /INSERT INTO projects/);
  assert.equal(insert.params.length, 7);
  // enabled_engines stored as JSON text
  assert.equal(insert.params[4], JSON.stringify(["mock", "codex"]));
  assert.equal(project.id, "prj_1");
});

test("SqlRepository: dialect controls placeholder syntax", async () => {
  const sqlite = makeRepo("sqlite");
  await sqlite.repo.getProject("x");
  assert.match(sqlite.client.queries.at(-1)!.sql, /WHERE id = \?/);

  const pg = makeRepo("postgres");
  await pg.repo.getProject("x");
  assert.match(pg.client.queries.at(-1)!.sql, /WHERE id = \$1/);
});

test("SqlRepository: getProject maps a row into an entity", async () => {
  const { client, repo } = makeRepo("sqlite");
  client.queueGet({
    id: "prj_9",
    name: "mapped",
    platform: "gitlab",
    default_engine: "claude-code",
    enabled_engines: JSON.stringify(["claude-code"]),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  });
  const project = await repo.getProject("prj_9");
  assert.equal(project?.platform, "gitlab");
  assert.deepEqual(project?.enabledEngines, ["claude-code"]);
});

const pendingJobRow = {
  id: "job_1",
  pull_request_id: "pr_1",
  engine: "mock",
  status: "pending",
  attempts: 0,
  progress: 0,
  error: null,
  logs: "[]",
  created_at: "2026-01-01T00:00:00.000Z",
  started_at: null,
  finished_at: null,
};

test("SqlRepository: legal transition issues UPDATE with incremented attempts", async () => {
  const { client, repo } = makeRepo("sqlite");
  client.queueGet({ ...pendingJobRow });
  const running = await repo.transitionReviewJob("job_1", "running", {
    progress: 25,
  });
  assert.equal(running.status, "running");
  assert.equal(running.attempts, 1);
  assert.ok(running.startedAt);
  const update = client.runs.at(-1);
  assert.match(update!.sql, /UPDATE review_jobs SET/);
  assert.equal(update!.params[0], "running"); // status
  assert.equal(update!.params[1], 1); // attempts
  assert.equal(update!.params[2], 25); // progress
});

test("SqlRepository: illegal transition throws and emits no UPDATE", async () => {
  const { client, repo } = makeRepo("sqlite");
  client.queueGet({ ...pendingJobRow, status: "succeeded" });
  await assert.rejects(
    repo.transitionReviewJob("job_1", "pending"),
    InvalidTransitionError,
  );
  assert.equal(client.runs.length, 0);
});

test("SqlRepository: listReviewJobs builds a filtered WHERE clause", async () => {
  const { client, repo } = makeRepo("postgres");
  client.queueAll([]);
  await repo.listReviewJobs({ status: "running", pullRequestId: "pr_1" });
  const q = client.queries.at(-1)!;
  assert.match(q.sql, /WHERE status = \$1 AND pull_request_id = \$2/);
  assert.deepEqual(q.params, ["running", "pr_1"]);
});
