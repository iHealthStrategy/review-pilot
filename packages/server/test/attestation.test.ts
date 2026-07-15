import assert from "node:assert/strict";
import { test } from "node:test";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import {
  type AttestClaims,
  type AttestSigner,
  buildAttestSigner,
  deriveKid,
  deriveVerdict,
  signAttestation,
  verifyAttestation,
} from "../src/auth/attestation.js";

/** A fresh Ed25519 PKCS#8 PEM private key for tests. */
function testKeyPem(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

function claimsFrom(signer: AttestSigner, findings: AttestClaims["findings"], now: number): AttestClaims {
  return {
    v: 1,
    project: "github.com/acme/app",
    treeSha: "deadbeefcafe",
    baseSha: "0000base",
    scope: "branch",
    findings,
    verdict: deriveVerdict(findings, signer.enforce, signer.blockSeverity),
    policy: signer.enforce,
    blockSeverity: signer.blockSeverity,
    sub: "usr_1",
    handle: "alice",
    iat: now,
    exp: now + signer.ttlMs,
    kid: signer.kid,
  };
}

test("attestation: sign → verify round-trip returns the claims", () => {
  const signer = buildAttestSigner({
    signingKey: testKeyPem(),
    keyId: "",
    enforce: "block",
    blockSeverity: "major",
    ttlMs: 60_000,
  })!;
  const now = 1_700_000_000_000;
  const claims = claimsFrom(signer, { critical: 0, major: 0, minor: 3, info: 1 }, now);
  const token = signAttestation(claims, signer);
  const back = verifyAttestation(token, signer.publicKeyPem, now);
  assert.ok(back);
  assert.equal(back.treeSha, "deadbeefcafe");
  assert.equal(back.verdict, "pass");
  assert.equal(back.project, "github.com/acme/app");
});

test("attestation: verdict gates only under block, at/above blockSeverity", () => {
  // block @ major: minor/info pass, major/critical fail.
  assert.equal(deriveVerdict({ critical: 0, major: 0, minor: 9, info: 9 }, "block", "major"), "pass");
  assert.equal(deriveVerdict({ critical: 0, major: 1, minor: 0, info: 0 }, "block", "major"), "fail");
  assert.equal(deriveVerdict({ critical: 1, major: 0, minor: 0, info: 0 }, "block", "major"), "fail");
  // block @ critical: a major no longer blocks.
  assert.equal(deriveVerdict({ critical: 0, major: 5, minor: 0, info: 0 }, "block", "critical"), "pass");
  // warn / off never block, even with criticals.
  assert.equal(deriveVerdict({ critical: 9, major: 9, minor: 0, info: 0 }, "warn", "major"), "pass");
  assert.equal(deriveVerdict({ critical: 9, major: 9, minor: 0, info: 0 }, "off", "major"), "pass");
});

test("attestation: a tampered payload is rejected (forged verdict/tree can't verify)", () => {
  const signer = buildAttestSigner({
    signingKey: testKeyPem(),
    keyId: "",
    enforce: "block",
    blockSeverity: "major",
    ttlMs: 60_000,
  })!;
  const now = 1_700_000_000_000;
  // Server would sign a FAIL for a major finding...
  const real = claimsFrom(signer, { critical: 0, major: 2, minor: 0, info: 0 }, now);
  assert.equal(real.verdict, "fail");
  const token = signAttestation(real, signer);
  const [header, , sig] = token.split(".");
  // ...attacker swaps in a pass payload but keeps the old signature.
  const forgedPayload = Buffer.from(
    JSON.stringify({ ...real, verdict: "pass", findings: { critical: 0, major: 0, minor: 0, info: 0 } }),
  ).toString("base64url");
  assert.equal(verifyAttestation(`${header}.${forgedPayload}.${sig}`, signer.publicKeyPem, now), null);
});

test("attestation: wrong public key and expiry are rejected", () => {
  const signer = buildAttestSigner({
    signingKey: testKeyPem(),
    keyId: "",
    enforce: "warn",
    blockSeverity: "major",
    ttlMs: 60_000,
  })!;
  const now = 1_700_000_000_000;
  const claims = claimsFrom(signer, { critical: 0, major: 0, minor: 0, info: 0 }, now);
  const token = signAttestation(claims, signer);

  // A different key pair must not verify.
  const { privateKey: other } = generateKeyPairSync("ed25519");
  const otherPub = createPublicKey(other).export({ type: "spki", format: "pem" }).toString();
  assert.equal(verifyAttestation(token, otherPub, now), null);

  // Past expiry → null.
  assert.equal(verifyAttestation(token, signer.publicKeyPem, now + 60_001), null);
  // Malformed token → null (no throw).
  assert.equal(verifyAttestation("not.a.token", signer.publicKeyPem, now), null);
  assert.equal(verifyAttestation("only-one-part", signer.publicKeyPem, now), null);
});

test("attestation: kid is stable and derived from the public key; explicit kid wins", () => {
  const pem = testKeyPem();
  const a = buildAttestSigner({ signingKey: pem, keyId: "", enforce: "off", blockSeverity: "major", ttlMs: 1 })!;
  const b = buildAttestSigner({ signingKey: pem, keyId: "", enforce: "off", blockSeverity: "major", ttlMs: 1 })!;
  assert.equal(a.kid, b.kid); // deterministic for the same key
  assert.equal(a.kid, deriveKid(createPublicKey(pem)));
  const c = buildAttestSigner({ signingKey: pem, keyId: "rp-2026", enforce: "off", blockSeverity: "major", ttlMs: 1 })!;
  assert.equal(c.kid, "rp-2026");
});

test("attestation: no signing key → null signer; non-ed25519 key → throws", () => {
  assert.equal(
    buildAttestSigner({ signingKey: "", keyId: "", enforce: "off", blockSeverity: "major", ttlMs: 1 }),
    null,
  );
  const { privateKey: rsa } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rsaPem = rsa.export({ type: "pkcs8", format: "pem" }).toString();
  assert.throws(
    () => buildAttestSigner({ signingKey: rsaPem, keyId: "", enforce: "off", blockSeverity: "major", ttlMs: 1 }),
    /Ed25519/,
  );
});
