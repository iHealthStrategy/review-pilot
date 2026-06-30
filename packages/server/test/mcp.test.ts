import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { startAppServer } from "../src/app.js";
import type { Platform } from "../src/domain/entities.js";
import { MemoryRepository } from "../src/persistence/memory-repository.js";
import type { Repository } from "../src/persistence/repository.js";
import type { UserRole } from "../src/domain/entities.js";
import { TaskService } from "../src/trigger/trigger-service.js";
import { makeSession } from "./auth-helper.js";
import { fixedClock, seqIdGen } from "./repository-contract.js";
import { SpyProvider } from "./spy-provider.js";

const SECRET = "test-session-secret";

async function withMcp(run: (base: string, repo: Repository) => Promise<void>): Promise<void> {
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

/** A user at the given role + a PAT for them (MCP authenticates via PATs). */
async function registerToken(repo: Repository, base: string, role: UserRole): Promise<string> {
  const { token } = await makeSession(repo, SECRET, role);
  const pat = await fetch(`${base}/api/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: "mcp" }),
  });
  return ((await pat.json()) as { token: string }).token;
}

async function mcp(base: string, pat: string | null, method: string, params?: unknown) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(pat ? { authorization: `Bearer ${pat}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

test("mcp: rejects unauthenticated calls", () =>
  withMcp(async (base) => {
    const res = await mcp(base, null, "tools/list");
    assert.equal(res.status, 401);
  }));

test("mcp: initialize returns protocol + server info", () =>
  withMcp(async (base, repo) => {
    const admin = await registerToken(repo, base, "admin");
    const res = await mcp(base, admin, "initialize", { protocolVersion: "2024-11-05" });
    assert.equal(res.status, 200);
    assert.ok(res.body.result.protocolVersion);
    assert.equal(res.body.result.serverInfo.name, "reviewpilot");
  }));

test("mcp: admin sees write tools and whoami reports admin", () =>
  withMcp(async (base, repo) => {
    const admin = await registerToken(repo, base, "admin");
    const list = await mcp(base, admin, "tools/list");
    const names = list.body.result.tools.map((t: { name: string }) => t.name);
    assert.ok(names.includes("create_review_task"), "admin sees the write tool");
    assert.ok(names.includes("whoami"));

    const who = await mcp(base, admin, "tools/call", { name: "whoami", arguments: {} });
    assert.equal(who.body.result.isError, undefined);
    assert.match(who.body.result.content[0].text, /"role":"admin"/);
  }));

test("mcp: a viewer PAT cannot see or call write tools", () =>
  withMcp(async (base, repo) => {
    const viewer = await registerToken(repo, base, "viewer");

    // tools/list is role-filtered: no write tools for a viewer.
    const list = await mcp(base, viewer, "tools/list");
    const names = list.body.result.tools.map((t: { name: string }) => t.name);
    assert.ok(names.includes("list_jobs"), "viewer sees read tools");
    assert.ok(!names.includes("create_review_task"), "viewer does NOT see write tools");

    // Calling it anyway is denied at the tool layer.
    const call = await mcp(base, viewer, "tools/call", {
      name: "create_review_task",
      arguments: { platform: "github", repoFullName: "a/b", prNumber: 1 },
    });
    assert.equal(call.body.result.isError, true);
    assert.match(call.body.result.content[0].text, /forbidden/);
  }));

test("mcp: create_review_task queues a job for a member+ caller", () =>
  withMcp(async (base, repo) => {
    const admin = await registerToken(repo, base, "admin");
    const call = await mcp(base, admin, "tools/call", {
      name: "create_review_task",
      arguments: { platform: "github", repoFullName: "acme/app", prNumber: 7 },
    });
    assert.equal(call.body.result.isError, undefined);
    assert.match(call.body.result.content[0].text, /"status":\s*"(created|deduped|accepted)"/);
  }));
