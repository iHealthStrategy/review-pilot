import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { test } from "node:test";
import {
  OidcClient,
  type OidcConfig,
  oidcEnabled,
  parseGroupRoleMap,
} from "../src/auth/oidc.js";
import { loginUser, provisionUser } from "../src/auth/provision.js";
import { MemoryRepository } from "../src/persistence/memory-repository.js";
import { fixedClock, seqIdGen } from "./repository-contract.js";

const ISS = "https://idp.example/application/o/app/";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: "jwk" }) as object), kid: "k1" };

function b64url(o: unknown): string {
  return Buffer.from(JSON.stringify(o)).toString("base64url");
}
function makeIdToken(payload: Record<string, unknown>): string {
  const signing = `${b64url({ alg: "RS256", typ: "JWT", kid: "k1" })}.${b64url(payload)}`;
  const sig = cryptoSign("RSA-SHA256", Buffer.from(signing), privateKey).toString("base64url");
  return `${signing}.${sig}`;
}
function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
/** A fetch stub serving discovery, JWKS, and the token endpoint (→ idToken). */
function stubFetch(idToken: string): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith("/.well-known/openid-configuration")) {
      return jsonRes({
        issuer: ISS,
        authorization_endpoint: `${ISS}authorize`,
        token_endpoint: `${ISS}token`,
        jwks_uri: `${ISS}jwks`,
        end_session_endpoint: `${ISS}end`,
      });
    }
    if (u === `${ISS}jwks`) return jsonRes({ keys: [jwk] });
    if (u === `${ISS}token`) return jsonRes({ id_token: idToken });
    return jsonRes({}, 404);
  }) as unknown as typeof fetch;
}

const baseCfg = (over: Partial<OidcConfig> = {}): OidcConfig => ({
  issuer: ISS,
  clientId: "client-1",
  clientSecret: "",
  scopes: "openid profile email",
  groupsClaim: "groups",
  groupRoleMap: { "reviewpilot-admins": "admin", "reviewpilot-members": "member" },
  syncRoles: false,
  defaultRole: "viewer",
  apiUrl: "",
  apiToken: "",
  ...over,
});

const NOW = Date.parse("2026-06-30T00:00:00.000Z");
const validPayload = (over: Record<string, unknown> = {}) => ({
  iss: ISS,
  aud: "client-1",
  exp: Math.floor(NOW / 1000) + 300,
  sub: "user-sub-1",
  email: "Dev@Example.com",
  preferred_username: "dev",
  name: "Dev",
  groups: ["reviewpilot-members"],
  nonce: "n1",
  ...over,
});

test("oidcEnabled / parseGroupRoleMap", () => {
  assert.equal(oidcEnabled(null), false);
  assert.equal(oidcEnabled(baseCfg()), true);
  assert.equal(oidcEnabled(baseCfg({ clientId: "" })), false);
  assert.deepEqual(parseGroupRoleMap("a:admin, b:member, c:bogus, d"), { a: "admin", b: "member" });
});

test("exchangeCode: verifies the ID token and resolves the identity + groups", async () => {
  const idToken = makeIdToken(validPayload());
  const c = new OidcClient(baseCfg(), stubFetch(idToken));
  const id = await c.exchangeCode({ code: "x", redirectUri: "r", codeVerifier: "v", nonce: "n1", now: NOW });
  assert.equal(id.sub, "user-sub-1");
  assert.equal(id.email, "dev@example.com"); // lowercased
  assert.equal(id.preferredUsername, "dev");
  assert.deepEqual(id.groups, ["reviewpilot-members"]);
});

test("exchangeCode: enriches a sparse id_token from the userinfo endpoint", async () => {
  // id_token carries only sub; email/preferred_username/groups come from userinfo.
  const idToken = makeIdToken({
    iss: ISS,
    aud: "client-1",
    exp: Math.floor(NOW / 1000) + 300,
    sub: "u-sparse",
    nonce: "n1",
  });
  const fetchFn = (async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith("/.well-known/openid-configuration")) {
      return jsonRes({
        issuer: ISS,
        authorization_endpoint: `${ISS}authorize`,
        token_endpoint: `${ISS}token`,
        jwks_uri: `${ISS}jwks`,
        userinfo_endpoint: `${ISS}userinfo`,
      });
    }
    if (u === `${ISS}jwks`) return jsonRes({ keys: [jwk] });
    if (u === `${ISS}token`) return jsonRes({ id_token: idToken, access_token: "at-123" });
    if (u === `${ISS}userinfo`) {
      return jsonRes({ sub: "u-sparse", email: "Sparse@Ex.com", preferred_username: "sparse", groups: ["reviewpilot-admins"] });
    }
    return jsonRes({}, 404);
  }) as unknown as typeof fetch;
  const c = new OidcClient(baseCfg(), fetchFn);
  const id = await c.exchangeCode({ code: "x", redirectUri: "r", codeVerifier: "v", nonce: "n1", now: NOW });
  assert.equal(id.email, "sparse@ex.com");
  assert.equal(id.preferredUsername, "sparse");
  assert.deepEqual(id.groups, ["reviewpilot-admins"]);
  assert.equal(c.roleForGroups(id.groups), "admin");
});

test("verifyIdToken: rejects tampered signature, wrong aud, expiry, and nonce", async () => {
  const c = new OidcClient(baseCfg(), stubFetch(""));
  const good = makeIdToken(validPayload());
  // tamper: flip the FIRST char of the signature segment (always significant;
  // the last base64url char can carry only a couple of bits and flip to a no-op).
  const parts = good.split(".");
  parts[2] = (parts[2]![0] === "A" ? "B" : "A") + parts[2]!.slice(1);
  await assert.rejects(c.verifyIdToken(parts.join("."), "n1", NOW), /signature/);
  await assert.rejects(c.verifyIdToken(makeIdToken(validPayload({ aud: "other" })), "n1", NOW), /audience/);
  await assert.rejects(
    c.verifyIdToken(makeIdToken(validPayload({ exp: Math.floor(NOW / 1000) - 10 })), "n1", NOW),
    /expired/,
  );
  await assert.rejects(c.verifyIdToken(makeIdToken(validPayload()), "wrong-nonce", NOW), /nonce/);
});

test("roleForGroups: highest-ranked mapped group wins; else defaultRole", () => {
  const c = new OidcClient(baseCfg());
  assert.equal(c.roleForGroups([]), "viewer");
  assert.equal(c.roleForGroups(["unmapped"]), "viewer");
  assert.equal(c.roleForGroups(["reviewpilot-members"]), "member");
  assert.equal(c.roleForGroups(["reviewpilot-members", "reviewpilot-admins"]), "admin");
  // A configurable default applies when nothing matches.
  const c2 = new OidcClient(baseCfg({ defaultRole: "member" }));
  assert.equal(c2.roleForGroups([]), "member");
  assert.equal(c2.roleForGroups(["reviewpilot-admins"]), "admin");
});

test("verifyIdToken: refetches JWKS on an unknown kid (key rotation), no wrong-key fallback", async () => {
  const kp0 = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kp1 = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk0 = { ...(kp0.publicKey.export({ format: "jwk" }) as object), kid: "old" };
  const jwk1 = { ...(kp1.publicKey.export({ format: "jwk" }) as object), kid: "new" };
  const signWith = (priv: import("node:crypto").KeyObject, kid: string): string => {
    const s = `${b64url({ alg: "RS256", typ: "JWT", kid })}.${b64url(validPayload())}`;
    return `${s}.${cryptoSign("RSA-SHA256", Buffer.from(s), priv).toString("base64url")}`;
  };
  let current = [jwk0];
  let jwksHits = 0;
  const fetchFn = (async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith("/.well-known/openid-configuration")) {
      return jsonRes({
        issuer: ISS,
        authorization_endpoint: `${ISS}authorize`,
        token_endpoint: `${ISS}token`,
        jwks_uri: `${ISS}jwks`,
      });
    }
    if (u === `${ISS}jwks`) {
      jwksHits += 1;
      return jsonRes({ keys: current });
    }
    return jsonRes({}, 404);
  }) as unknown as typeof fetch;

  const c = new OidcClient(baseCfg(), fetchFn);
  // First login with the old key → caches JWKS [old].
  await c.verifyIdToken(signWith(kp0.privateKey, "old"), "n1", NOW);
  // Provider rotates: cache still has [old], token carries the new kid → must
  // refetch JWKS and verify against the new key rather than failing.
  current = [jwk1];
  await c.verifyIdToken(signWith(kp1.privateKey, "new"), "n1", NOW);
  assert.ok(jwksHits >= 2, "JWKS was refetched on the unknown kid");
  // A kid present nowhere → clear error, never a silent wrong-key fallback.
  await assert.rejects(c.verifyIdToken(signWith(kp1.privateKey, "ghost"), "n1", NOW), /no JWKS key for kid/);
});

test("loginUser: syncRoles=false seeds only; true re-syncs (incl. demotion) every login", async () => {
  const repo = new MemoryRepository({ clock: fixedClock(), idGen: seqIdGen() });
  await repo.init();
  const id = { sub: "s1", email: "e@x.com", name: "", preferredUsername: "e", groups: [] };
  // First login creates the account seeded from groups.
  assert.equal((await loginUser(repo, id, "viewer", false)).role, "viewer");
  // syncRoles=false: an existing account keeps its stored role (local authoritative).
  assert.equal((await loginUser(repo, id, "admin", false)).role, "viewer");
  // syncRoles=true: IdP authoritative — promote…
  assert.equal((await loginUser(repo, id, "admin", true)).role, "admin");
  // …and demote when the group no longer maps to admin.
  assert.equal((await loginUser(repo, id, "viewer", true)).role, "viewer");
});

test("provisionUser: create by sub, then link by email, idempotent on sub", async () => {
  const repo = new MemoryRepository({ clock: fixedClock(), idGen: seqIdGen() });
  await repo.init();
  const idA = { sub: "sub-A", email: "a@x.com", name: "", preferredUsername: "alice", groups: [] };

  // First login → creates, seeding role from groups (member here).
  const u1 = await provisionUser(repo, idA, "member");
  assert.equal(u1.externalId, "sub-A");
  assert.equal(u1.role, "member");
  assert.equal(u1.handle, "alice");

  // Same sub again → returns the same row, role unchanged even if seed differs.
  const u1again = await provisionUser(repo, idA, "admin");
  assert.equal(u1again.id, u1.id);
  assert.equal(u1again.role, "member", "local role is authoritative; not overwritten on login");

  // A pre-existing email-only account gets linked to its subject on first login.
  const legacy = await repo.createUser({ email: "legacy@x.com", handle: "legacy", externalId: "", role: "admin" });
  const linked = await provisionUser(
    repo,
    { sub: "sub-legacy", email: "legacy@x.com", name: "", preferredUsername: "legacy", groups: [] },
    "viewer",
  );
  assert.equal(linked.id, legacy.id, "matched by email");
  assert.equal(linked.externalId, "sub-legacy");
  assert.equal(linked.role, "admin", "existing role preserved");

  // A different subject presenting the SAME email must NOT rebind the account.
  await assert.rejects(
    provisionUser(
      repo,
      { sub: "sub-other", email: "legacy@x.com", name: "", preferredUsername: "legacy", groups: [] },
      "viewer",
    ),
    /already linked to a different identity/,
  );
});

test("provisionUser: emailless IdP accounts each get a distinct (placeholder) record", async () => {
  const repo = new MemoryRepository({ clock: fixedClock(), idGen: seqIdGen() });
  await repo.init();
  const mk = (sub: string) => ({ sub, email: "", name: "", preferredUsername: sub, groups: [] });
  const a = await provisionUser(repo, mk("hex-a"), "viewer");
  const b = await provisionUser(repo, mk("hex-b"), "viewer");
  // No email → keyed on sub; distinct users, distinct non-empty placeholder emails.
  assert.notEqual(a.id, b.id);
  assert.equal(a.externalId, "hex-a");
  assert.equal(b.externalId, "hex-b");
  assert.ok(a.email && b.email && a.email !== b.email, "distinct placeholder emails");
  // Idempotent on the same subject (no duplicate record on re-login).
  assert.equal((await provisionUser(repo, mk("hex-a"), "member")).id, a.id);
});
