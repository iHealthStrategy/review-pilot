import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAppServer } from "../src/app.js";
import type { Platform } from "../src/domain/entities.js";
import { MemoryRepository } from "../src/persistence/memory-repository.js";
import type { Repository } from "../src/persistence/repository.js";
import { TaskService } from "../src/trigger/trigger-service.js";
import { FileAttestPolicyStore, type AttestPolicyDefaults } from "../src/attest/policy-store.js";
import { verifyAttestation } from "../src/auth/attestation.js";
import { makeSession } from "./auth-helper.js";
import { fixedClock, seqIdGen } from "./repository-contract.js";
import { SpyProvider } from "./spy-provider.js";

const SECRET = "test-session-secret";

function keyPem(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

async function req(
  base: string,
  method: string,
  path: string,
  token: string | undefined,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function withApi(
  run: (base: string, repo: Repository) => Promise<void>,
  opts: { defaults?: AttestPolicyDefaults } = {},
): Promise<void> {
  const repo = new MemoryRepository({ clock: fixedClock(), idGen: seqIdGen() });
  await repo.init();
  const taskService = new TaskService({
    repo,
    providerFor: (_p: Platform) => new SpyProvider(),
    defaultEngine: "mock",
    enabledEngines: ["mock"],
  });
  const attestPolicyStore = new FileAttestPolicyStore({
    defaults: opts.defaults ?? { enforce: "warn", blockSeverity: "major" },
  });
  await attestPolicyStore.init();
  const server = startAppServer(
    {
      repo,
      taskService,
      sessionSecret: SECRET,
      attest: { signingKey: keyPem(), keyId: "", enforce: "warn", blockSeverity: "major", ttlMs: 60_000 },
      attestPolicyStore,
    },
    0,
  );
  await new Promise<void>((r) => server.once("listening", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(base, repo);
  } finally {
    server.close();
  }
}

test("policy store: file round-trip seeds from defaults then persists changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-policy-"));
  const filePath = join(dir, "policy.json");
  const defaults: AttestPolicyDefaults = { enforce: "warn", blockSeverity: "major" };

  const a = new FileAttestPolicyStore({ defaults, filePath, clock: () => "2026-01-01T00:00:00Z" });
  await a.init();
  assert.deepEqual(await a.get(), { enforce: "warn", blockSeverity: "major", updatedAt: "", updatedBy: "default" });
  await a.set({ enforce: "block", blockSeverity: "critical" }, "@admin");
  assert.deepEqual(await a.get(), {
    enforce: "block",
    blockSeverity: "critical",
    updatedAt: "2026-01-01T00:00:00Z",
    updatedBy: "@admin",
  });

  // A fresh store over the same file loads the persisted value, not the default.
  const b = new FileAttestPolicyStore({ defaults, filePath });
  await b.init();
  const loaded = await b.get();
  assert.equal(loaded.enforce, "block");
  assert.equal(loaded.blockSeverity, "critical");
  assert.equal(loaded.updatedBy, "@admin");
});

test("policy API: viewer can read, only admin can change", async () => {
  await withApi(async (base, repo) => {
    const viewer = await makeSession(repo, SECRET, "viewer");
    const member = await makeSession(repo, SECRET, "member");
    const admin = await makeSession(repo, SECRET, "admin");

    // Seeded default is readable by any authenticated user.
    const seen = await req(base, "GET", "/api/attest/policy", viewer.token);
    assert.equal(seen.status, 200);
    assert.equal(seen.json.enforce, "warn");

    // A member cannot change it.
    const denied = await req(base, "PUT", "/api/attest/policy", member.token, { enforce: "block" });
    assert.equal(denied.status, 403);

    // An admin can.
    const changed = await req(base, "PUT", "/api/attest/policy", admin.token, {
      enforce: "block",
      blockSeverity: "major",
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.json.enforce, "block");
    assert.match(changed.json.updatedBy, /admin|@u\d/);

    // Bad value rejected.
    const bad = await req(base, "PUT", "/api/attest/policy", admin.token, { enforce: "sometimes" });
    assert.equal(bad.status, 400);
  });
});

test("attest issuance reflects the live Web-UI policy, not the env seed", async () => {
  await withApi(async (base, repo) => {
    const dev = await makeSession(repo, SECRET, "member");
    const admin = await makeSession(repo, SECRET, "admin");

    const body = { project: "github.com/acme/app", treeSha: "tree-1", scope: "branch", major: 1 };

    // Seed is warn → a major finding still passes.
    const warn = await req(base, "POST", "/api/attest", dev.token, body);
    assert.equal(warn.status, 201);
    assert.equal(warn.json.verdict, "pass");
    assert.equal(warn.json.policy, "warn");

    // Admin flips to block via the API (the "Web UI" control).
    await req(base, "PUT", "/api/attest/policy", admin.token, { enforce: "block", blockSeverity: "major" });

    // Same request now fails — no server restart, no env change.
    const blocked = await req(base, "POST", "/api/attest", dev.token, body);
    assert.equal(blocked.status, 201);
    assert.equal(blocked.json.verdict, "fail");
    assert.equal(blocked.json.policy, "block");

    // The signed token really carries the live verdict (verify with the pubkey).
    const pk = await req(base, "GET", "/api/attest/pubkey", dev.token);
    assert.equal(pk.json.enforce, "block");
    const claims = verifyAttestation(blocked.json.token, pk.json.publicKey, Date.now());
    assert.ok(claims);
    assert.equal(claims.verdict, "fail");
    assert.equal(claims.treeSha, "tree-1");
  });
});
