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

test("rulesets: anyone may read a public one in full; an admin may edit someone else's", () =>
  withApi(async (base, repo) => {
    const alice = await register(repo, "alice@x.com");
    const bob = await register(repo, "bob@x.com");
    const root = await register(repo, "root@x.com", "admin");
    const rs = (await (await fetch(`${base}/api/rulesets`, {
      method: "POST",
      headers: auth(alice),
      body: JSON.stringify({
        name: "Alice Rules",
        visibility: "public",
        instructions: "x",
        rules: [{ title: "SQL", instruction: "no injection", globs: ["**/*.sql"] }],
      }),
    })).json()) as any;
    const hidden = (await (await fetch(`${base}/api/rulesets`, {
      method: "POST",
      headers: auth(alice),
      body: JSON.stringify({ name: "Hidden", visibility: "private", instructions: "secret" }),
    })).json()) as any;

    // Read-only detail: a non-owner sees the PUBLIC ruleset in full (rules included).
    const seen = await fetch(`${base}/api/rulesets/${rs.id}`, { headers: auth(bob) });
    assert.equal(seen.status, 200);
    assert.equal(((await seen.json()) as any).rules[0].title, "SQL");
    // …but a private one stays hidden from a non-owner member.
    assert.equal((await fetch(`${base}/api/rulesets/${hidden.id}`, { headers: auth(bob) })).status, 404);
    // An admin may read it (they may also edit it).
    assert.equal((await fetch(`${base}/api/rulesets/${hidden.id}`, { headers: auth(root) })).status, 200);

    // Reading is not writing: bob still cannot edit Alice's public ruleset.
    assert.equal(
      (await fetch(`${base}/api/rulesets/${rs.id}`, {
        method: "PUT", headers: auth(bob), body: JSON.stringify({ name: "hijack" }),
      })).status,
      404,
    );

    // An admin CAN edit it — and the ruleset stays owned by Alice.
    const edited = await fetch(`${base}/api/rulesets/${rs.id}`, {
      method: "PUT",
      headers: auth(root),
      body: JSON.stringify({ name: "Moderated", instructions: "y" }),
    });
    assert.equal(edited.status, 200);
    const after = (await edited.json()) as any;
    assert.equal(after.name, "Moderated");
    assert.equal(after.instructions, "y");
    assert.equal(after.ownerId, rs.ownerId, "moderation must not transfer ownership");
    assert.equal(after.ownerHandle, "alice");
    // It is still listed as Alice's, not the admin's.
    const adminOwn = (await (await fetch(`${base}/api/rulesets`, { headers: auth(root) })).json()) as any[];
    assert.equal(adminOwn.length, 0);
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

test("candidates: skill auto-grows the caller's per-project ruleset (in effect by default); disabling / legacy pending hide a rule", () =>
  withApi(async (base, repo) => {
    const alice = await register(repo, "alice@x.com");

    // First submit: no ruleset for this project yet → creates one (private).
    // Candidates now take effect immediately — no pending confirmation step.
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
    assert.notEqual(r1.ruleset.rules[0].pending, true); // in effect, not pending
    assert.notEqual(r1.ruleset.rules[0].disabled, true);

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

    // Make it public — both rules are in effect, so discovery exposes them.
    await fetch(`${base}/api/rulesets/${r1.ruleset.id}`, {
      method: "PUT", headers: auth(alice), body: JSON.stringify({ visibility: "public" }),
    });
    const disc = (await (await fetch(`${base}/api/u/alice/rulesets?project=github.com/acme/app`)).json()) as any;
    assert.equal(disc.rulesets.length, 1);
    assert.equal(disc.rulesets[0].rules.length, 2, "in-effect candidates are visible");

    // Owner disables one rule via PUT → discovery hides just that one.
    const toggled = r2.ruleset.rules.map((x: any, i: number) => ({ ...x, disabled: i === 0 }));
    await fetch(`${base}/api/rulesets/${r1.ruleset.id}`, {
      method: "PUT", headers: auth(alice), body: JSON.stringify({ rules: toggled }),
    });
    const disc2 = (await (await fetch(`${base}/api/u/alice/rulesets?project=github.com/acme/app`)).json()) as any;
    assert.equal(disc2.rulesets[0].rules.length, 1, "disabled rule hidden from discovery");

    // Legacy `pending` flag still hides a rule (backward-compat, no migration).
    const withPending = r2.ruleset.rules.map((x: any, i: number) => ({ ...x, disabled: false, pending: i === 1 }));
    await fetch(`${base}/api/rulesets/${r1.ruleset.id}`, {
      method: "PUT", headers: auth(alice), body: JSON.stringify({ rules: withPending }),
    });
    const disc3 = (await (await fetch(`${base}/api/u/alice/rulesets?project=github.com/acme/app`)).json()) as any;
    assert.equal(disc3.rulesets[0].rules.length, 1, "legacy pending rule hidden; the other in effect");

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

    // Per-host builds of the SAME ruleset: each lands in that host's skills dir,
    // and the visibility rules are unchanged by the platform segment.
    const codex = await (await fetch(`${base}/skill/ruleset/${pub.id}/codex/install.sh`)).text();
    assert.match(codex, /\$HOME\/\.codex\/skills\/reviewpilot-pub/);
    assert.match(codex, /rule A/);
    const cursor = await (await fetch(`${base}/skill/ruleset/${pub.id}/cursor/install.sh`)).text();
    assert.match(cursor, /\$HOME\/\.cursor\/skills\/reviewpilot-pub/);
    assert.equal((await fetch(`${base}/skill/ruleset/${priv.id}/codex/install.sh`)).status, 401);
    // An unknown platform segment is not a route — it must not leak a private skill.
    assert.equal((await fetch(`${base}/skill/ruleset/${priv.id}/windsurf/install.sh`)).status, 404);
  }));

// --- Rule load budget + hit counting -----------------------------------------
// A project's ruleset grows on every auto-grow, so discovery must rank and cap
// the rules it hands a review rather than shipping the whole tail.

const mkRule = (title: string, extra: Record<string, unknown> = {}) => ({
  title, instruction: `check ${title}`, globs: [], languages: [], topics: [], ...extra,
});

test("discovery: ranks and caps the rules a review loads, and says what it dropped", () =>
  withApi(async (base, repo) => {
    const owner = await register(repo, "owner@x.com");
    const rules = Array.from({ length: 60 }, (_, i) => mkRule(`rule ${i}`, { hits: i }));
    const rs = (await (await fetch(`${base}/api/rulesets`, {
      method: "POST", headers: auth(owner),
      body: JSON.stringify({ name: "Big", visibility: "public", rules }),
    })).json()) as any;
    assert.equal(rs.rules.length, 60, "all 60 are STORED");

    const disc = (await (await fetch(`${base}/api/u/owner/rulesets`)).json()) as any;
    const got = disc.rulesets[0];
    assert.equal(disc.ruleLimit, 40, "default budget");
    assert.equal(got.rules.length, 40, "only the ranked top 40 are SENT");
    assert.equal(got.ruleTotal, 60);
    assert.equal(got.ruleOmitted, 20);
    // Highest hits first, so the rules that keep catching things lead.
    assert.equal(got.rules[0].title, "rule 59");
    // The cold tail is thinned, not banished: a rotating handful of never-hit
    // rules ride along so they can still earn their way up.
    const coldLoaded = got.rules.filter((r: any) => !r.hits).length;
    assert.ok(coldLoaded > 0, "some never-hit rules get a rotating trial slot");
    assert.ok(coldLoaded < 20, `the tail is still mostly dropped (got ${coldLoaded} of 40)`);

    // A bare request must use the DEFAULT budget, never "load nothing":
    // Number(null) is 0, so an absent ?limit= is easy to mis-parse as a zero cap.
    assert.ok(got.rules.length > 0, "no ?limit= must not mean zero rules");
    // limit=0 IS a real request, though: totals without the payload.
    const none = (await (await fetch(`${base}/api/u/owner/rulesets?limit=0`)).json()) as any;
    assert.equal(none.ruleLimit, 0);
    assert.equal(none.rulesets[0].rules.length, 0);
    assert.equal(none.rulesets[0].ruleTotal, 60, "totals still reported");

    // An explicit smaller budget is honoured...
    const small = (await (await fetch(`${base}/api/u/owner/rulesets?limit=5`)).json()) as any;
    assert.equal(small.rulesets[0].rules.length, 5);
    assert.equal(small.rulesets[0].ruleOmitted, 55);
    // ...and an absurd one is clamped, so a caller cannot re-create the slow path.
    const huge = (await (await fetch(`${base}/api/u/owner/rulesets?limit=99999`)).json()) as any;
    assert.equal(huge.ruleLimit, 200);
  }));

test("discovery: still hides disabled and legacy pending rules", () =>
  withApi(async (base, repo) => {
    const owner = await register(repo, "owner@x.com");
    await fetch(`${base}/api/rulesets`, {
      method: "POST", headers: auth(owner),
      body: JSON.stringify({
        name: "Mixed", visibility: "public",
        rules: [mkRule("live"), mkRule("off", { disabled: true }), mkRule("legacy", { pending: true })],
      }),
    });
    const disc = (await (await fetch(`${base}/api/u/owner/rulesets`)).json()) as any;
    assert.deepEqual(disc.rulesets[0].rules.map((r: any) => r.title), ["live"]);
    assert.equal(disc.rulesets[0].ruleTotal, 1, "ineligible rules are outside the budget");
  }));

test("rule hits: reporting a hit floats the rule up the ranking", () =>
  withApi(async (base, repo) => {
    const owner = await register(repo, "owner@x.com");
    const rs = (await (await fetch(`${base}/api/rulesets`, {
      method: "POST", headers: auth(owner),
      body: JSON.stringify({
        name: "R", visibility: "public",
        rules: [mkRule("quiet one"), mkRule("useful one")],
      }),
    })).json()) as any;

    const hit = await fetch(`${base}/api/rulesets/${rs.id}/rule-hits`, {
      method: "POST", headers: auth(owner), body: JSON.stringify({ titles: ["useful one"] }),
    });
    assert.equal(hit.status, 200);
    assert.deepEqual(await hit.json(), { matched: 1, updated: true });

    const after = await repo.getRuleset(rs.id);
    const useful = after!.rules.find((r) => r.title === "useful one")!;
    assert.equal(useful.hits, 1);
    assert.ok(useful.lastHitAt, "stamped");
    // Discovery now orders the hit rule first.
    const disc = (await (await fetch(`${base}/api/u/owner/rulesets`)).json()) as any;
    assert.equal(disc.rulesets[0].rules[0].title, "useful one");
  }));

test("rule hits: unknown titles are a no-op, not an error", () =>
  withApi(async (base, repo) => {
    const owner = await register(repo, "owner@x.com");
    const rs = (await (await fetch(`${base}/api/rulesets`, {
      method: "POST", headers: auth(owner),
      body: JSON.stringify({ name: "R", visibility: "public", rules: [mkRule("a")] }),
    })).json()) as any;
    for (const titles of [["renamed away"], [], undefined]) {
      const res = await fetch(`${base}/api/rulesets/${rs.id}/rule-hits`, {
        method: "POST", headers: auth(owner), body: JSON.stringify({ titles }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { matched: 0, updated: false });
    }
    assert.equal((await fetch(`${base}/api/rulesets/nope/rule-hits`, {
      method: "POST", headers: auth(owner), body: JSON.stringify({ titles: ["a"] }),
    })).status, 404);
  }));

test("rule hits: anyone may report on a PUBLIC ruleset; a private one only its owner", () =>
  withApi(async (base, repo) => {
    const owner = await register(repo, "owner@x.com");
    const stranger = await register(repo, "stranger@x.com");
    const mk = async (visibility: string) =>
      (await (await fetch(`${base}/api/rulesets`, {
        method: "POST", headers: auth(owner),
        body: JSON.stringify({ name: visibility, visibility, rules: [mkRule("a")] }),
      })).json()) as any;
    const pub = await mk("public");
    const priv = await mk("private");
    const report = (id: string, token?: string) =>
      fetch(`${base}/api/rulesets/${id}/rule-hits`, {
        method: "POST",
        headers: token ? auth(token) : { "content-type": "application/json" },
        body: JSON.stringify({ titles: ["a"] }),
      });

    // A shared ruleset only improves if its users feed hits back.
    assert.equal((await report(pub.id, stranger)).status, 200);
    // A private ruleset must not be rankable by outsiders.
    assert.equal((await report(priv.id, stranger)).status, 403);
    assert.equal((await report(priv.id, owner)).status, 200);
    // Reporting is never anonymous.
    assert.equal((await report(pub.id)).status, 401);
  }));

test("rule hits survive an owner edit that resends the whole rules array", () =>
  withApi(async (base, repo) => {
    const owner = await register(repo, "owner@x.com");
    const rs = (await (await fetch(`${base}/api/rulesets`, {
      method: "POST", headers: auth(owner),
      body: JSON.stringify({ name: "R", visibility: "private", rules: [mkRule("a")] }),
    })).json()) as any;
    await fetch(`${base}/api/rulesets/${rs.id}/rule-hits`, {
      method: "POST", headers: auth(owner), body: JSON.stringify({ titles: ["a"] }),
    });
    const withHits = await repo.getRuleset(rs.id);
    assert.equal(withHits!.rules[0]!.hits, 1);

    // The web editor round-trips the ranking fields; a save must not reset them.
    const put = await fetch(`${base}/api/rulesets/${rs.id}`, {
      method: "PUT", headers: auth(owner),
      body: JSON.stringify({ rules: withHits!.rules.map((r) => ({ ...r, instruction: "edited" })) }),
    });
    assert.equal(put.status, 200);
    const after = await repo.getRuleset(rs.id);
    assert.equal(after!.rules[0]!.instruction, "edited");
    assert.equal(after!.rules[0]!.hits, 1, "earned hit count preserved across an edit");
    assert.equal(after!.rules[0]!.lastHitAt, withHits!.rules[0]!.lastHitAt);
  }));

test("auto-grown candidates are stamped so the ranking can give them a trial slot", () =>
  withApi(async (base, repo) => {
    const owner = await register(repo, "owner@x.com");
    const res = await fetch(`${base}/api/rulesets/candidates`, {
      method: "POST", headers: auth(owner),
      body: JSON.stringify({
        project: "github.com/acme/app",
        rules: [{ title: "New rule", instruction: "check it", globs: [], languages: [], topics: [] }],
      }),
    });
    assert.equal(res.status, 201);
    const rs = (await res.json()) as any;
    const rule = rs.ruleset.rules[0];
    assert.ok(rule.createdAt, "stamped with a creation time");
    assert.ok(Number.isFinite(Date.parse(rule.createdAt)));
    assert.equal(rule.hits, undefined, "a brand-new rule has no hits yet");
  }));

// --- GET /api/review-rules: own + borrowed, merged into ONE ranked pool -------
// The skill used to load only the unauthenticated public-discovery endpoint, so a
// user's own auto-grown rules (private by default) never actually applied. This
// endpoint authenticates so it can include them, and merges them with a named
// reviewer's public rules under a single shared budget.

const mkSet = async (
  base: string, token: string,
  opts: { name: string; visibility: string; project?: string; rules: unknown[]; focus?: string; instructions?: string },
) =>
  (await (await fetch(`${base}/api/rulesets`, {
    method: "POST", headers: auth(token),
    body: JSON.stringify({
      name: opts.name, visibility: opts.visibility,
      // The server derives the normalized key from `project`; `projectLabel` is
      // only the display string (this mirrors what the web form posts).
      project: opts.project ?? "", projectLabel: opts.project ?? "",
      rules: opts.rules,
      focus: opts.focus ?? "", instructions: opts.instructions ?? "",
    }),
  })).json()) as any;

const reviewRules = async (base: string, token: string, qs = "") =>
  (await (await fetch(`${base}/api/review-rules${qs}`, { headers: auth(token) })).json()) as any;

test("review-rules: loads the caller's OWN private rules (what auto-grow depends on)", () =>
  withApi(async (base, repo) => {
    const me = await register(repo, "me@x.com");
    const mine = await mkSet(base, me, {
      name: "mine", visibility: "private", project: "github.com/acme/app",
      rules: [mkRule("my own rule")],
    });
    const got = await reviewRules(base, me, "?project=github.com/acme/app");
    assert.deepEqual(got.rules.map((r: any) => r.title), ["my own rule"]);
    // rulesetId routes a later hit report back to the right ruleset.
    assert.equal(got.rules[0].rulesetId, mine.id);
    assert.equal(got.sources.length, 1);
    assert.equal(got.sources[0].origin, "self");
  }));

test("review-rules: no reviewer named still loads your own rules", () =>
  withApi(async (base, repo) => {
    const me = await register(repo, "me@x.com");
    await mkSet(base, me, {
      name: "mine", visibility: "private", project: "github.com/acme/app",
      rules: [mkRule("mine only")],
    });
    // This is the common phrasing ("评审一下我的改动") — no handle at all.
    const got = await reviewRules(base, me, "?project=github.com/acme/app");
    assert.equal(got.rules.length, 1);
    assert.equal(got.reviewer, undefined);
    // An empty reviewer param behaves the same way.
    const blank = await reviewRules(base, me, "?project=github.com/acme/app&reviewer=");
    assert.equal(blank.rules.length, 1);
    assert.equal(blank.reviewer, undefined);
  }));

test("review-rules: an absent reviewer must not borrow from the handle 'ruleset'", () =>
  withApi(async (base, repo) => {
    // slugify("") returns "ruleset", so an unguarded slugify would silently
    // borrow the public rules of whoever happens to hold that handle.
    const me = await register(repo, "me@x.com");
    const trap = await register(repo, "ruleset@x.com");
    await mkSet(base, trap, {
      name: "trap", visibility: "public", project: "github.com/acme/app",
      rules: [mkRule("should not leak in")],
    });
    const trapUser = (await repo.listUsers()).find((u) => u.email === "ruleset@x.com")!;
    assert.equal(trapUser.handle, "ruleset", "precondition: the trap handle really is 'ruleset'");

    for (const qs of ["?project=github.com/acme/app", "?project=github.com/acme/app&reviewer="]) {
      const got = await reviewRules(base, me, qs);
      assert.deepEqual(got.rules, [], `no reviewer named → nothing borrowed (${qs})`);
    }
    // Naming it explicitly still works — the guard is about the ABSENT case.
    const named = await reviewRules(base, me, "?project=github.com/acme/app&reviewer=ruleset");
    assert.deepEqual(named.rules.map((r: any) => r.title), ["should not leak in"]);
  }));

test("review-rules: merges own + a named reviewer's PUBLIC rules, never their private", () =>
  withApi(async (base, repo) => {
    const me = await register(repo, "me@x.com");
    const alice = await register(repo, "alice@x.com");
    await mkSet(base, me, {
      name: "mine", visibility: "private", project: "github.com/acme/app",
      rules: [mkRule("mine")],
    });
    await mkSet(base, alice, {
      name: "alice public", visibility: "public", project: "github.com/acme/app",
      rules: [mkRule("alice public rule")],
    });
    await mkSet(base, alice, {
      name: "alice secret", visibility: "private", project: "github.com/acme/app",
      rules: [mkRule("alice private rule")],
    });

    const got = await reviewRules(base, me, "?project=github.com/acme/app&reviewer=alice");
    const loaded = got.rules.map((r: any) => r.title).sort();
    assert.deepEqual(loaded, ["alice public rule", "mine"]);
    assert.ok(!loaded.includes("alice private rule"), "another user's private rules stay private");
    const origins = Object.fromEntries(got.sources.map((s: any) => [s.name, s.origin]));
    assert.deepEqual(origins, { mine: "self", "alice public": "borrowed" });
  }));

test("review-rules: own and borrowed rules SHARE one budget and rank on equal terms", () =>
  withApi(async (base, repo) => {
    const me = await register(repo, "me@x.com");
    const alice = await register(repo, "alice@x.com");
    // 30 of mine and 30 of alice's. A per-ruleset cap would return 60; one shared
    // budget returns 40, picked by hits regardless of who owns the rule.
    await mkSet(base, me, {
      name: "mine", visibility: "private", project: "github.com/acme/app",
      rules: Array.from({ length: 30 }, (_, i) => mkRule(`mine-${i}`, { hits: i })),
    });
    await mkSet(base, alice, {
      name: "alice", visibility: "public", project: "github.com/acme/app",
      rules: Array.from({ length: 30 }, (_, i) => mkRule(`alice-${i}`, { hits: i })),
    });

    const got = await reviewRules(base, me, "?project=github.com/acme/app&reviewer=alice");
    assert.equal(got.ruleLimit, 40);
    assert.equal(got.ruleTotal, 60, "one pool of 60");
    assert.equal(got.rules.length, 40, "ONE shared budget, not 40 per ruleset");
    assert.equal(got.ruleOmitted, 20);
    // Equal priority: the two owners' highest-hit rules interleave at the top
    // rather than one owner's block preceding the other's.
    const top = got.rules.slice(0, 4).map((r: any) => r.title);
    assert.ok(top.some((t: string) => t.startsWith("mine-")), `own rules in the lead: ${top}`);
    assert.ok(top.some((t: string) => t.startsWith("alice-")), `borrowed rules in the lead: ${top}`);
    // Both owners contribute roughly evenly, since their hit profiles match.
    const counts = got.rules.reduce((a: any, r: any) => {
      const k = r.title.split("-")[0];
      a[k] = (a[k] || 0) + 1;
      return a;
    }, {});
    assert.ok(Math.abs(counts.mine - counts.alice) <= 4, `balanced, got ${JSON.stringify(counts)}`);
  }));

test("review-rules: an 'any project' ruleset applies alongside project-scoped ones", () =>
  withApi(async (base, repo) => {
    const me = await register(repo, "me@x.com");
    await mkSet(base, me, { name: "global", visibility: "private", rules: [mkRule("everywhere")] });
    await mkSet(base, me, {
      name: "scoped", visibility: "private", project: "github.com/acme/app",
      rules: [mkRule("here only")],
    });
    await mkSet(base, me, {
      name: "elsewhere", visibility: "private", project: "github.com/acme/other",
      rules: [mkRule("other project")],
    });
    const got = await reviewRules(base, me, "?project=github.com/acme/app");
    assert.deepEqual(got.rules.map((r: any) => r.title).sort(), ["everywhere", "here only"]);
  }));

test("review-rules: freeform focus/instructions ride along outside the rule budget", () =>
  withApi(async (base, repo) => {
    const me = await register(repo, "me@x.com");
    await mkSet(base, me, {
      name: "prose", visibility: "private", project: "github.com/acme/app",
      rules: [], focus: "并发安全", instructions: "- 禁止 console.log",
    });
    const got = await reviewRules(base, me, "?project=github.com/acme/app");
    assert.equal(got.rules.length, 0);
    // Prose still reaches the skill even with no selector-matched rules.
    assert.equal(got.sources.length, 1);
    assert.equal(got.sources[0].focus, "并发安全");
    assert.equal(got.sources[0].instructions, "- 禁止 console.log");
    assert.equal(got.ruleTotal, 0, "prose is not counted against the rule budget");
  }));

test("review-rules: disabled rules are excluded, and requires authentication", () =>
  withApi(async (base, repo) => {
    const me = await register(repo, "me@x.com");
    await mkSet(base, me, {
      name: "mixed", visibility: "private", project: "github.com/acme/app",
      rules: [mkRule("live"), mkRule("off", { disabled: true }), mkRule("legacy", { pending: true })],
    });
    const got = await reviewRules(base, me, "?project=github.com/acme/app");
    assert.deepEqual(got.rules.map((r: any) => r.title), ["live"]);
    // Private rules are involved, so anonymous access must be refused.
    assert.equal((await fetch(`${base}/api/review-rules?project=github.com/acme/app`)).status, 401);
  }));

test("review-rules: hits reported via rulesetId feed straight back into the ranking", () =>
  withApi(async (base, repo) => {
    const me = await register(repo, "me@x.com");
    const rs = await mkSet(base, me, {
      name: "mine", visibility: "private", project: "github.com/acme/app",
      rules: [mkRule("quiet"), mkRule("useful")],
    });
    const before = await reviewRules(base, me, "?project=github.com/acme/app");
    const useful = before.rules.find((r: any) => r.title === "useful");
    // Round-trip: the id handed to the skill is the id the hit endpoint accepts.
    const hit = await fetch(`${base}/api/rulesets/${useful.rulesetId}/rule-hits`, {
      method: "POST", headers: auth(me), body: JSON.stringify({ titles: ["useful"] }),
    });
    assert.equal(hit.status, 200);
    assert.equal(useful.rulesetId, rs.id);
    const after = await reviewRules(base, me, "?project=github.com/acme/app");
    assert.equal(after.rules[0].title, "useful", "the rule that caught something now leads");
    assert.equal(after.rules[0].hits, 1);
  }));
