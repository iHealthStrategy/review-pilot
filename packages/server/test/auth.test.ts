import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { startAppServer } from "../src/app.js";
import type { OidcConfig } from "../src/auth/oidc.js";
import type { Platform } from "../src/domain/entities.js";
import { MemoryRepository } from "../src/persistence/memory-repository.js";
import type { Repository } from "../src/persistence/repository.js";
import { TaskService } from "../src/trigger/trigger-service.js";
import { makeSession } from "./auth-helper.js";
import { fixedClock, seqIdGen } from "./repository-contract.js";
import { SpyProvider } from "./spy-provider.js";

const SECRET = "test-session-secret";

async function withAuthApi(
  run: (base: string, repo: Repository) => Promise<void>,
  opts: { adminEmail?: string; adminToken?: string; oidc?: OidcConfig; publicBaseUrl?: string } = {},
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

const PROJECT = { name: "p", platform: "github", defaultEngine: "mock", enabledEngines: ["mock"] };
// Auth is delegated to the OIDC provider; the env admin is now a token-only
// break-glass admin (no password login).
const ENV_ADMIN = { adminEmail: "root@corp.com", adminToken: "envadmin-secret-token-xyz" };

test("RBAC: viewer can read but not write; member/admin can write", () =>
  withAuthApi(async (base, repo) => {
    const { token: admin } = await makeSession(repo, SECRET, "admin");
    const { token: viewer } = await makeSession(repo, SECRET, "viewer");

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
  withAuthApi(async (base, repo) => {
    const { token: admin } = await makeSession(repo, SECRET, "admin");
    const { token: viewerToken, user: viewer } = await makeSession(repo, SECRET, "viewer");

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
    const upgrade = await fetch(`${base}/api/users/${viewer.id}/role`, {
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
  withAuthApi(async (base, repo) => {
    const { token: admin } = await makeSession(repo, SECRET, "admin");

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

test("skill token: a user gets a stable derived token that authenticates", () =>
  withAuthApi(async (base, repo) => {
    const { token: sess } = await makeSession(repo, SECRET, "member");
    const r = await fetch(`${base}/api/auth/skill-token`, { headers: authHeaders(sess) });
    assert.equal(r.status, 200);
    const body = (await r.json()) as any;
    assert.equal(body.kind, "user");
    assert.ok(String(body.token).startsWith("rsk_"));
    // The skill token authenticates as the user, via "token".
    const me = await fetch(`${base}/api/auth/me`, { headers: authHeaders(body.token) });
    assert.equal(me.status, 200);
    assert.equal(((await me.json()) as any).via, "token");
    // Stable across calls (derived, not stored).
    const again = (await (await fetch(`${base}/api/auth/skill-token`, { headers: authHeaders(sess) })).json()) as any;
    assert.equal(again.token, body.token);
  }));

test("env admin: configured ADMIN_TOKEN authenticates as admin without a DB row", () =>
  withAuthApi(async (base, repo) => {
    const TOK = ENV_ADMIN.adminToken; // need not have the rpat_ prefix
    assert.equal(await repo.countUsers(), 0, "env admin is not stored in the DB");
    // /api/auth/me resolves to the env admin via the token.
    const me = await fetch(`${base}/api/auth/me`, { headers: authHeaders(TOK) });
    assert.equal(me.status, 200);
    const body = (await me.json()) as any;
    assert.equal(body.user.role, "admin");
    assert.equal(body.via, "token");
    // Admin-only route reachable with the token; a wrong token is rejected.
    assert.equal((await fetch(`${base}/api/users`, { headers: authHeaders(TOK) })).status, 200);
    assert.equal((await fetch(`${base}/api/auth/me`, { headers: authHeaders("nope") })).status, 401);
    assert.equal(await repo.countUsers(), 0);
  }, ENV_ADMIN));

test("env admin: cannot mint personal tokens (it has no DB row)", () =>
  withAuthApi(async (base) => {
    const res = await fetch(`${base}/api/tokens`, {
      method: "POST",
      headers: authHeaders(ENV_ADMIN.adminToken),
      body: JSON.stringify({ name: "ci" }),
    });
    assert.equal(res.status, 400);
  }, ENV_ADMIN));

test("env admin: skill token is the configured ADMIN_TOKEN", () =>
  withAuthApi(async (base) => {
    const body = (await (
      await fetch(`${base}/api/auth/skill-token`, { headers: authHeaders(ENV_ADMIN.adminToken) })
    ).json()) as any;
    assert.equal(body.kind, "admin");
    assert.equal(body.configured, true);
    assert.equal(body.token, ENV_ADMIN.adminToken);
  }, ENV_ADMIN));

// When roles are delegated to the IdP (OIDC role-sync on), local role editing is
// disabled and /me advertises the flag so the UI can render roles read-only.
const OIDC_SYNC: { oidc: OidcConfig; publicBaseUrl: string } = {
  publicBaseUrl: "https://test.local",
  oidc: {
    issuer: "https://idp.example/application/o/app/",
    clientId: "c",
    clientSecret: "",
    scopes: "openid",
    groupsClaim: "groups",
    groupRoleMap: {},
    syncRoles: true,
    defaultRole: "viewer",
    apiUrl: "",
    apiToken: "",
  },
};

test("roles managed externally: PATCH /users/:id/role is rejected + /me advertises it", () =>
  withAuthApi(async (base, repo) => {
    const { token: admin } = await makeSession(repo, SECRET, "admin");
    const { user: viewer } = await makeSession(repo, SECRET, "viewer");

    const me = (await (await fetch(`${base}/api/auth/me`, { headers: authHeaders(admin) })).json()) as any;
    assert.equal(me.rolesManagedExternally, true);

    const res = await fetch(`${base}/api/users/${viewer.id}/role`, {
      method: "PATCH",
      headers: authHeaders(admin),
      body: JSON.stringify({ role: "member" }),
    });
    assert.equal(res.status, 409);
  }, OIDC_SYNC));
