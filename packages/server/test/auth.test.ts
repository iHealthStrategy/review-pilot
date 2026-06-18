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

async function withAuthApi(
  run: (base: string, repo: Repository) => Promise<void>,
  opts: { adminEmail?: string; adminPassword?: string } = {},
): Promise<void> {
  const repo = new MemoryRepository({ clock: fixedClock(), idGen: seqIdGen() });
  await repo.init();
  const taskService = new TaskService({
    repo,
    providerFor: (_p: Platform) => new SpyProvider(),
    defaultEngine: "mock",
    enabledEngines: ["mock"],
  });
  const server = startAppServer({ repo, taskService, sessionSecret: SECRET, ...opts }, 0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(base, repo);
  } finally {
    server.close();
  }
}

function authHeaders(token?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function register(base: string, email: string, password: string) {
  const res = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ email, password }),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

const PROJECT = { name: "p", platform: "github", defaultEngine: "mock", enabledEngines: ["mock"] };
const ENV_ADMIN = { adminEmail: "root@corp.com", adminPassword: "rootpassword1" };

async function login(base: string, email: string, password: string) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ email, password }),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

test("register: first user is admin, subsequent users are viewers", () =>
  withAuthApi(async (base) => {
    const a = await register(base, "a@x.com", "password1");
    assert.equal(a.status, 201);
    assert.equal(a.body.user.role, "admin");
    assert.equal(a.body.user.email, "a@x.com");
    assert.ok(a.body.token, "register returns a session token");
    assert.equal(a.body.user.passwordHash, undefined, "never leaks the hash");

    const b = await register(base, "b@x.com", "password1");
    assert.equal(b.status, 201);
    assert.equal(b.body.user.role, "viewer");
  }));

test("register: rejects duplicate email, bad email, and weak password", () =>
  withAuthApi(async (base) => {
    await register(base, "dup@x.com", "password1");
    assert.equal((await register(base, "DUP@x.com", "password1")).status, 409); // case-insensitive
    assert.equal((await register(base, "not-an-email", "password1")).status, 400);
    assert.equal((await register(base, "weak@x.com", "short")).status, 400);
  }));

test("login: correct password returns a token; wrong is rejected", () =>
  withAuthApi(async (base) => {
    await register(base, "u@x.com", "password1");
    const okRes = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ email: "u@x.com", password: "password1" }),
    });
    assert.equal(okRes.status, 200);
    assert.ok(((await okRes.json()) as { token?: string }).token);

    const bad = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ email: "u@x.com", password: "wrong" }),
    });
    assert.equal(bad.status, 401);
  }));

test("RBAC: viewer can read but not write; member/admin can write", () =>
  withAuthApi(async (base) => {
    const admin = (await register(base, "admin@x.com", "password1")).body.token;
    const viewer = (await register(base, "viewer@x.com", "password1")).body.token;

    // Unauthenticated → 401.
    assert.equal((await fetch(`${base}/api/projects`)).status, 401);

    // Viewer: GET ok, POST forbidden.
    assert.equal(
      (await fetch(`${base}/api/projects`, { headers: authHeaders(viewer) })).status,
      200,
    );
    const viewerWrite = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: authHeaders(viewer),
      body: JSON.stringify(PROJECT),
    });
    assert.equal(viewerWrite.status, 403);

    // Admin (member+): POST allowed.
    const adminWrite = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: authHeaders(admin),
      body: JSON.stringify(PROJECT),
    });
    assert.equal(adminWrite.status, 201);
  }));

test("admin can upgrade a viewer to member; takes effect on the existing token", () =>
  withAuthApi(async (base) => {
    const admin = (await register(base, "admin@x.com", "password1")).body.token;
    const viewerReg = await register(base, "v@x.com", "password1");
    const viewerToken = viewerReg.body.token;
    const viewerId = viewerReg.body.user.id;

    // Before upgrade: viewer write is forbidden.
    assert.equal(
      (await fetch(`${base}/api/projects`, {
        method: "POST",
        headers: authHeaders(viewerToken),
        body: JSON.stringify(PROJECT),
      })).status,
      403,
    );

    // A non-admin cannot reach user administration.
    assert.equal(
      (await fetch(`${base}/api/users`, { headers: authHeaders(viewerToken) })).status,
      403,
    );

    // Admin upgrades the viewer to member.
    const upgrade = await fetch(`${base}/api/users/${viewerId}/role`, {
      method: "PATCH",
      headers: authHeaders(admin),
      body: JSON.stringify({ role: "member" }),
    });
    assert.equal(upgrade.status, 200);

    // The SAME token now passes a write route — role is re-read from the store.
    assert.equal(
      (await fetch(`${base}/api/projects`, {
        method: "POST",
        headers: authHeaders(viewerToken),
        body: JSON.stringify(PROJECT),
      })).status,
      201,
    );
  }));

test("personal access tokens: create, authenticate with, and revoke", () =>
  withAuthApi(async (base) => {
    const admin = (await register(base, "admin@x.com", "password1")).body.token;

    // Mint a PAT.
    const created = await fetch(`${base}/api/tokens`, {
      method: "POST",
      headers: authHeaders(admin),
      body: JSON.stringify({ name: "ci" }),
    });
    assert.equal(created.status, 201);
    const pat = (await created.json()) as { id: string; token: string; prefix: string };
    assert.ok(pat.token.startsWith("rpat_"), "returns the plaintext secret once");

    // The PAT authenticates as that user (admin → can write).
    const withPat = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: authHeaders(pat.token),
      body: JSON.stringify(PROJECT),
    });
    assert.equal(withPat.status, 201);

    // Listing tokens never exposes the secret/hash.
    const list = (await (await fetch(`${base}/api/tokens`, { headers: authHeaders(admin) })).json()) as any[];
    assert.equal(list.length, 1);
    assert.equal(list[0].token, undefined);
    assert.equal(list[0].tokenHash, undefined);

    // Revoke → the PAT no longer authenticates.
    assert.equal(
      (await fetch(`${base}/api/tokens/${pat.id}`, { method: "DELETE", headers: authHeaders(admin) })).status,
      200,
    );
    assert.equal(
      (await fetch(`${base}/api/projects`, { headers: authHeaders(pat.token) })).status,
      401,
    );
  }));

test("env admin: logs in as a permanent admin without any DB user", () =>
  withAuthApi(async (base, repo) => {
    assert.equal(await repo.countUsers(), 0, "env admin is not stored in the DB");
    const bad = await login(base, ENV_ADMIN.adminEmail, "wrong-password");
    assert.equal(bad.status, 401);

    const good = await login(base, ENV_ADMIN.adminEmail, ENV_ADMIN.adminPassword);
    assert.equal(good.status, 200);
    assert.equal(good.body.user.role, "admin");
    const token = good.body.token as string;

    // Full admin powers (e.g. user administration) and still no DB user created.
    assert.equal((await fetch(`${base}/api/users`, { headers: authHeaders(token) })).status, 200);
    assert.equal((await fetch(`${base}/api/auth/me`, { headers: authHeaders(token) })).status, 200);
    assert.equal(await repo.countUsers(), 0);
  }, ENV_ADMIN));

test("env admin: reserves its email and demotes the first registered user to viewer", () =>
  withAuthApi(async (base) => {
    // Reserved email cannot be registered.
    assert.equal((await register(base, ENV_ADMIN.adminEmail, "password1")).status, 409);
    // With an env admin present, the first self-registered user is a viewer.
    const first = await register(base, "first@x.com", "password1");
    assert.equal(first.status, 201);
    assert.equal(first.body.user.role, "viewer");
  }, ENV_ADMIN));

test("env admin: cannot mint personal tokens (it has no DB row)", () =>
  withAuthApi(async (base) => {
    const token = (await login(base, ENV_ADMIN.adminEmail, ENV_ADMIN.adminPassword)).body.token;
    const res = await fetch(`${base}/api/tokens`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ name: "ci" }),
    });
    assert.equal(res.status, 400);
  }, ENV_ADMIN));
