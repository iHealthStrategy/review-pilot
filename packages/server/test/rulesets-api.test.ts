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

async function register(base: string, email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password1" }),
  });
  return ((await res.json()) as { token: string }).token;
}
const auth = (t: string) => ({ "content-type": "application/json", authorization: `Bearer ${t}` });

test("rulesets: a viewer can self-create, edit, and only sees their own + public", () =>
  withApi(async (base) => {
    await register(base, "admin@x.com"); // first user = admin
    const viewer = await register(base, "viewer@x.com"); // viewer (read-only role)

    // Self-service: a viewer CAN create their own ruleset.
    const created = await fetch(`${base}/api/rulesets`, {
      method: "POST",
      headers: auth(viewer),
      body: JSON.stringify({ name: "My Rules", visibility: "private", focus: "security", instructions: "no console.log" }),
    });
    assert.equal(created.status, 201);
    const rs = (await created.json()) as any;
    assert.equal(rs.ownerEmail, "viewer@x.com");
    assert.equal(rs.slug, "my-rules");

    // Edit own.
    const upd = await fetch(`${base}/api/rulesets/${rs.id}`, {
      method: "PUT",
      headers: auth(viewer),
      body: JSON.stringify({ visibility: "public" }),
    });
    assert.equal(upd.status, 200);
    assert.equal(((await upd.json()) as any).visibility, "public");

    // mine vs public listing.
    const mine = (await (await fetch(`${base}/api/rulesets`, { headers: auth(viewer) })).json()) as any[];
    assert.equal(mine.length, 1);
    const pub = (await (await fetch(`${base}/api/rulesets?scope=public`, { headers: auth(viewer) })).json()) as any[];
    assert.ok(pub.some((r) => r.id === rs.id));
  }));

test("rulesets: cannot edit someone else's; can fork a public one", () =>
  withApi(async (base) => {
    const alice = await register(base, "alice@x.com");
    const bob = await register(base, "bob@x.com");
    const rs = (await (await fetch(`${base}/api/rulesets`, {
      method: "POST",
      headers: auth(alice),
      body: JSON.stringify({ name: "Alice Rules", visibility: "public", instructions: "x" }),
    })).json()) as any;

    // Bob can't edit Alice's ruleset (owner-scoped → 404).
    const edit = await fetch(`${base}/api/rulesets/${rs.id}`, {
      method: "PUT",
      headers: auth(bob),
      body: JSON.stringify({ name: "hijack" }),
    });
    assert.equal(edit.status, 404);

    // Bob forks it into his own (private copy).
    const fork = await fetch(`${base}/api/rulesets/${rs.id}/fork`, { method: "POST", headers: auth(bob) });
    assert.equal(fork.status, 201);
    const forked = (await fork.json()) as any;
    assert.equal(forked.visibility, "private");
    assert.match(forked.name, /fork/);
    assert.equal(forked.instructions, "x");
    assert.equal((await (await fetch(`${base}/api/rulesets`, { headers: auth(bob) })).json() as any[]).length, 1);
  }));

test("ruleset skill: public installs openly; private needs the owner's token", () =>
  withApi(async (base) => {
    const owner = await register(base, "owner@x.com");
    const stranger = await register(base, "stranger@x.com");
    const pub = (await (await fetch(`${base}/api/rulesets`, {
      method: "POST", headers: auth(owner),
      body: JSON.stringify({ name: "Pub", visibility: "public", instructions: "rule A" }),
    })).json()) as any;
    const priv = (await (await fetch(`${base}/api/rulesets`, {
      method: "POST", headers: auth(owner),
      body: JSON.stringify({ name: "Priv", visibility: "private", instructions: "secret rule" }),
    })).json()) as any;

    // Public ruleset: install.sh is open (no auth) and embeds the ruleset.
    const openRes = await fetch(`${base}/skill/ruleset/${pub.id}/install.sh`);
    assert.equal(openRes.status, 200);
    assert.match(openRes.headers.get("content-type") ?? "", /shellscript/);
    const sh = await openRes.text();
    assert.match(sh, /reviewpilot-pub/);
    assert.match(sh, /rule A/);

    // Private ruleset: anonymous → 401; stranger → 401; owner → 200.
    assert.equal((await fetch(`${base}/skill/ruleset/${priv.id}/install.sh`)).status, 401);
    assert.equal(
      (await fetch(`${base}/skill/ruleset/${priv.id}/install.sh`, { headers: { authorization: `Bearer ${stranger}` } })).status,
      401,
    );
    assert.equal(
      (await fetch(`${base}/skill/ruleset/${priv.id}/install.sh`, { headers: { authorization: `Bearer ${owner}` } })).status,
      200,
    );
  }));
