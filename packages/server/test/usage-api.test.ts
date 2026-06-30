import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { startAppServer } from "../src/app.js";
import type { Platform } from "../src/domain/entities.js";
import { MemoryRepository } from "../src/persistence/memory-repository.js";
import type { Repository } from "../src/persistence/repository.js";
import { TaskService } from "../src/trigger/trigger-service.js";
import { fixedClock, seqIdGen } from "./repository-contract.js";
import { SpyProvider } from "./spy-provider.js";

const SECRET = "test-session-secret";

async function withApi(run: (base: string, repo: Repository) => Promise<void>): Promise<void> {
  const repo = new MemoryRepository({ clock: fixedClock(), idGen: seqIdGen() });
  await repo.init();
  const taskService = new TaskService({
    repo,
    providerFor: (_p: Platform) => new SpyProvider(),
    defaultEngine: "mock",
    enabledEngines: ["mock"],
  });
  const server = startAppServer({ repo, taskService, sessionSecret: SECRET }, 0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(base, repo);
  } finally {
    server.close();
  }
}

async function viewerToken(base: string): Promise<string> {
  await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@x.com", password: "password1" }),
  });
  const reg = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "viewer@x.com", password: "password1" }),
  });
  return ((await reg.json()) as { token: string }).token;
}

async function seed(repo: Repository) {
  await repo.recordTokenUsage({
    source: "schedule", sourceId: "sch_1", sourceLabel: "nightly", engine: "claude-agent",
    inputTokens: 100, outputTokens: 40, estimated: false, at: "2026-06-22T08:00:00.000Z",
  });
  await repo.recordTokenUsage({
    source: "schedule", sourceId: "sch_1", sourceLabel: "nightly", engine: "claude-agent",
    inputTokens: 60, outputTokens: 20, estimated: true, at: "2026-06-22T20:00:00.000Z",
  });
  await repo.recordTokenUsage({
    source: "task", sourceId: "acme/app", sourceLabel: "acme/app", engine: "claude-code",
    inputTokens: 30, outputTokens: 10, estimated: true, at: "2026-06-22T09:00:00.000Z",
  });
}

test("GET /api/usage requires auth", () =>
  withApi(async (base) => {
    assert.equal((await fetch(`${base}/api/usage`)).status, 401);
  }));

test("GET /api/usage aggregates by day and is readable by a viewer", () =>
  withApi(async (base, repo) => {
    await seed(repo);
    const token = await viewerToken(base);
    const res = await fetch(`${base}/api/usage?bucket=day`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { bucket: string; rows: any[] };
    assert.equal(body.bucket, "day");
    // Two distinct (source,sourceId) groups on the same day.
    const sched = body.rows.find((r) => r.source === "schedule" && r.sourceId === "sch_1");
    assert.ok(sched);
    assert.equal(sched.runs, 2);
    assert.equal(sched.totalTokens, 220); // (100+40)+(60+20)
    assert.equal(sched.estimated, true); // one of the two was estimated
    const task = body.rows.find((r) => r.source === "task");
    assert.equal(task.totalTokens, 40);
  }));

test("GET /api/usage?source=task filters to tasks only", () =>
  withApi(async (base, repo) => {
    await seed(repo);
    const token = await viewerToken(base);
    const res = await fetch(`${base}/api/usage?bucket=month&source=task`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as { rows: any[] };
    assert.ok(body.rows.length >= 1);
    assert.ok(body.rows.every((r) => r.source === "task"));
  }));

// --- Skill usage upload + per-user visibility ---

async function register(base: string, email: string) {
  const res = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password1" }),
  });
  return (await res.json()) as { token: string; user: { id: string; role: string } };
}

function postSkill(base: string, token: string, body: unknown) {
  return fetch(`${base}/api/usage/skill`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("POST /api/usage/skill requires auth", () =>
  withApi(async (base) => {
    const res = await fetch(`${base}/api/usage/skill`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "working" }),
    });
    assert.equal(res.status, 401);
  }));

test("POST /api/usage/skill records a run attributed to the caller", () =>
  withApi(async (base) => {
    await register(base, "admin@x.com"); // first user → admin
    const u = await register(base, "dev@x.com");
    const res = await postSkill(base, u.token, {
      project: "github.com/acme/app",
      scope: "working",
      critical: 1,
      major: 2,
      minor: 0,
      info: 5,
    });
    assert.equal(res.status, 201);
  }));

test("GET /api/usage/skill: admin sees all users, others see only themselves", () =>
  withApi(async (base) => {
    const admin = await register(base, "admin@x.com");
    const dev = await register(base, "dev@x.com");
    await postSkill(base, dev.token, { project: "p", scope: "working", critical: 1, major: 0, minor: 0, info: 0 });
    await postSkill(base, dev.token, { project: "p", scope: "branch", critical: 0, major: 1, minor: 0, info: 0 });
    await postSkill(base, admin.token, { project: "p", scope: "whole", critical: 0, major: 0, minor: 3, info: 0 });

    const asAdmin = (await (
      await fetch(`${base}/api/usage/skill?bucket=month`, { headers: { authorization: `Bearer ${admin.token}` } })
    ).json()) as { scope: string; rows: any[] };
    assert.equal(asAdmin.scope, "all");
    assert.equal(asAdmin.rows.length, 2, "admin sees both users");
    const devRow = asAdmin.rows.find((r) => r.userId === dev.user.id);
    assert.equal(devRow.runs, 2);
    assert.equal(devRow.findings, 2); // 1 critical + 1 major across the two runs
    assert.equal(devRow.critical, 1);
    assert.equal(devRow.major, 1);

    const asDev = (await (
      await fetch(`${base}/api/usage/skill?bucket=month`, { headers: { authorization: `Bearer ${dev.token}` } })
    ).json()) as { scope: string; rows: any[] };
    assert.equal(asDev.scope, "self");
    assert.equal(asDev.rows.length, 1, "non-admin sees only their own");
    assert.equal(asDev.rows[0].userId, dev.user.id);
  }));
