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
import { provisionUser } from "../src/auth/provision.js";
import { signSession } from "../src/auth/session.js";
import type { UserRole } from "../src/domain/entities.js";

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

async function register(repo: Repository, email: string, role: UserRole = "member"): Promise<string> {
  // Provision the user as an OIDC first-login would (exercises handle generation),
  // then mint a session token for them.
  const user = await provisionUser(
    repo,
    { sub: `sub:${email}`, email, name: "", preferredUsername: "", groups: [] },
    role,
  );
  return signSession({ sub: user.id, role: user.role }, SECRET, 3_600_000);
}
const auth = (t: string) => ({ "content-type": "application/json", authorization: `Bearer ${t}` });

test("rulesets: a viewer can self-create, edit, and only sees their own + public", () =>
  withApi(async (base, repo) => {
    const viewer = await register(repo, "viewer@x.com", "viewer");

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
  withApi(async (base, repo) => {
    const alice = await register(repo, "alice@x.com");
    const bob = await register(repo, "bob@x.com");
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

test("rulesets: register assigns a handle; public discovery by handle is unauthenticated", () =>
  withApi(async (base, repo) => {
    // Two users share an email local-part → handles must stay unique.
    const a = await register(repo, "alice@x.com");
    const a2 = await register(repo, "alice@y.com");
    const meA = (await (await fetch(`${base}/api/auth/me`, { headers: auth(a) })).json()) as any;
    const meA2 = (await (await fetch(`${base}/api/auth/me`, { headers: auth(a2) })).json()) as any;
    assert.equal(meA.user.handle, "alice");
    assert.equal(meA2.user.handle, "alice-2"); // collision suffixed
    assert.notEqual(meA.user.handle, meA2.user.handle);

    // alice publishes one public + one private ruleset.
    const pub = (await (await fetch(`${base}/api/rulesets`, {
      method: "POST", headers: auth(a),
      body: JSON.stringify({
        name: "Public Set", visibility: "public", instructions: "always rule",
        rules: [{ title: "SQL", instruction: "no injection", globs: ["**/*.sql"], languages: ["sql"], topics: ["security"] }],
      }),
    })).json()) as any;
    assert.equal(pub.ownerHandle, "alice");
    assert.equal(pub.rules.length, 1);
    await fetch(`${base}/api/rulesets`, {
      method: "POST", headers: auth(a),
      body: JSON.stringify({ name: "Hidden", visibility: "private", instructions: "secret" }),
    });

    // Public discovery: NO Authorization header, only public rulesets returned.
    const disc = await fetch(`${base}/api/u/alice/rulesets`);
    assert.equal(disc.status, 200);
    const body = (await disc.json()) as any;
    assert.equal(body.handle, "alice");
    // Unauthenticated endpoint must NOT leak PII: only the public handle.
    assert.equal(body.owner.handle, "alice");
    assert.equal(body.owner.email, undefined, "owner email must not be exposed");
    assert.equal(body.rulesets.length, 1); // private one excluded
    assert.equal(body.rulesets[0].id, pub.id);
    assert.equal(body.rulesets[0].rules[0].title, "SQL");
    assert.equal(body.rulesets[0].ownerEmail, undefined, "ruleset must not carry owner email");
    assert.equal(body.rulesets[0].ownerId, undefined, "ruleset must not carry owner id");
    assert.equal(body.rulesets[0].ownerHandle, "alice"); // handle is fine

    // Unknown handle → empty, still 200 (skill handles "not found" gracefully).
    const none = (await (await fetch(`${base}/api/u/nobody/rulesets`)).json()) as any;
    assert.equal(none.rulesets.length, 0);
  }));

test("candidates: skill auto-grows the caller's per-project ruleset (pending) and discovery hides pending", () =>
  withApi(async (base, repo) => {
    const alice = await register(repo, "alice@x.com");

    // First submit: no ruleset for this project yet → creates one (private), pending rules.
    const sub1 = await fetch(`${base}/api/rulesets/candidates`, {
      method: "POST", headers: auth(alice),
      body: JSON.stringify({
        // Non-normalized remote URL — server normalizes to github.com/acme/app.
        project: "git@github.com:acme/App.git", projectLabel: "acme/App",
        rules: [{ title: "迁移", instruction: "DB 迁移需可回滚", globs: ["**/migrations/**"], topics: ["db"] }],
      }),
    });
    assert.equal(sub1.status, 201);
    const r1 = (await sub1.json()) as any;
    assert.equal(r1.added, 1);
    assert.equal(r1.ruleset.project, "github.com/acme/app");
    assert.equal(r1.ruleset.visibility, "private");
    assert.equal(r1.ruleset.rules[0].pending, true);

    // Second submit, same project (different remote spelling) → upserts same ruleset.
    const sub2 = await fetch(`${base}/api/rulesets/candidates`, {
      method: "POST", headers: auth(alice),
      body: JSON.stringify({
        project: "https://github.com/acme/app",
        rules: [
          { title: "迁移", instruction: "DB 迁移需可回滚" }, // dup → skipped
          { title: "日志", instruction: "禁止 console.log" }, // new
        ],
      }),
    });
    const r2 = (await sub2.json()) as any;
    assert.equal(sub2.status, 200);
    assert.equal(r2.ruleset.id, r1.ruleset.id, "same project → same ruleset");
    assert.equal(r2.added, 1);
    assert.equal(r2.skipped, 1);
    assert.equal(r2.ruleset.rules.length, 2);

    // Make it public — discovery must still hide pending candidates.
    await fetch(`${base}/api/rulesets/${r1.ruleset.id}`, {
      method: "PUT", headers: auth(alice), body: JSON.stringify({ visibility: "public" }),
    });
    const disc = (await (await fetch(`${base}/api/u/alice/rulesets?project=github.com/acme/app`)).json()) as any;
    assert.equal(disc.rulesets.length, 1);
    assert.equal(disc.rulesets[0].rules.length, 0, "pending candidates hidden from discovery");

    // Owner promotes one candidate (clear pending) via PUT → discovery now shows it.
    const promoted = r2.ruleset.rules.map((x: any, i: number) => ({ ...x, pending: i === 0 ? false : x.pending }));
    await fetch(`${base}/api/rulesets/${r1.ruleset.id}`, {
      method: "PUT", headers: auth(alice), body: JSON.stringify({ rules: promoted }),
    });
    const disc2 = (await (await fetch(`${base}/api/u/alice/rulesets?project=github.com/acme/app`)).json()) as any;
    assert.equal(disc2.rulesets[0].rules.length, 1, "promoted rule now visible");

    // A different project filter excludes this project-scoped ruleset.
    const other = (await (await fetch(`${base}/api/u/alice/rulesets?project=github.com/acme/other`)).json()) as any;
    assert.equal(other.rulesets.length, 0);
  }));

test("ruleset skill: public installs openly; private needs the owner's token", () =>
  withApi(async (base, repo) => {
    const owner = await register(repo, "owner@x.com");
    const stranger = await register(repo, "stranger@x.com");
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
