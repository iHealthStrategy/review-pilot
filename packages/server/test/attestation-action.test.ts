import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import {
  type AttestClaims,
  type AttestSigner,
  buildAttestSigner,
  signAttestation,
} from "../src/auth/attestation.js";

/**
 * Cross-drift guard: the GitHub Action's self-contained verifier
 * (verify-attestation/verify.mjs) MUST accept exactly what the server signs and
 * reject everything it should. We import the action's verifier at runtime (via a
 * URL so tsc doesn't type-check a file outside the project) and feed it
 * server-issued tokens.
 */
const verifyModUrl = new URL("../../../../verify-attestation/verify.mjs", import.meta.url).href;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type VerifyMod = {
  verifyToken: (o: {
    token: string;
    actualTreeSha: string;
    expectedProject: string;
    pems: string[];
    pemByKid?: Record<string, string>;
    now: number;
  }) => { ok: boolean; reason?: string; claims?: AttestClaims };
  FAIL: Record<string, string>;
};

function testKeyPem(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

const NOW = 1_700_000_000_000;
const PROJECT = "github.com/acme/app";
const TREE = "aaaa1111tree";

function claims(signer: AttestSigner, over: Partial<AttestClaims> = {}): AttestClaims {
  return {
    v: 1,
    project: PROJECT,
    treeSha: TREE,
    scope: "branch",
    findings: { critical: 0, major: 0, minor: 0, info: 0 },
    verdict: "pass",
    policy: signer.enforce,
    blockSeverity: signer.blockSeverity,
    sub: "usr_1",
    handle: "alice",
    iat: NOW,
    exp: NOW + signer.ttlMs,
    kid: signer.kid,
    ...over,
  };
}

test("action verifier accepts a valid server-signed attestation", async () => {
  const { verifyToken } = (await import(verifyModUrl)) as VerifyMod;
  const signer = buildAttestSigner({
    signingKey: testKeyPem(),
    keyId: "",
    enforce: "block",
    blockSeverity: "major",
    ttlMs: 60_000,
  })!;
  const token = signAttestation(claims(signer), signer);
  const r = verifyToken({
    token,
    actualTreeSha: TREE,
    expectedProject: PROJECT,
    pems: [signer.publicKeyPem],
    now: NOW,
  });
  assert.equal(r.ok, true);
  assert.equal(r.claims?.handle, "alice");
});

test("action verifier rejects: tree mismatch, project mismatch, fail verdict, expiry, no token", async () => {
  const { verifyToken, FAIL } = (await import(verifyModUrl)) as VerifyMod;
  const signer = buildAttestSigner({
    signingKey: testKeyPem(),
    keyId: "",
    enforce: "block",
    blockSeverity: "major",
    ttlMs: 60_000,
  })!;
  const base = { expectedProject: PROJECT, pems: [signer.publicKeyPem], now: NOW };
  const passToken = signAttestation(claims(signer), signer);

  // Code changed after review → the tree no longer matches.
  assert.equal(
    verifyToken({ ...base, token: passToken, actualTreeSha: "different-tree" }).reason,
    FAIL.TREE_MISMATCH,
  );
  // Token minted for another repo.
  assert.equal(
    verifyToken({ ...base, token: passToken, actualTreeSha: TREE, expectedProject: "github.com/evil/repo" }).reason,
    FAIL.PROJECT_MISMATCH,
  );
  // A failing verdict (policy blocked) must not merge.
  const failToken = signAttestation(claims(signer, { verdict: "fail" }), signer);
  assert.equal(verifyToken({ ...base, token: failToken, actualTreeSha: TREE }).reason, FAIL.VERDICT_FAIL);
  // Expired.
  assert.equal(
    verifyToken({ ...base, token: passToken, actualTreeSha: TREE, now: NOW + 60_001 }).reason,
    FAIL.EXPIRED,
  );
  // Missing trailer.
  assert.equal(verifyToken({ ...base, token: "", actualTreeSha: TREE }).reason, FAIL.NO_TOKEN);
});

test("action verifier rejects a tampered payload and the wrong key", async () => {
  const { verifyToken, FAIL } = (await import(verifyModUrl)) as VerifyMod;
  const signer = buildAttestSigner({
    signingKey: testKeyPem(),
    keyId: "",
    enforce: "block",
    blockSeverity: "major",
    ttlMs: 60_000,
  })!;
  // Server signs FAIL; attacker swaps in a pass payload, keeps the signature.
  const failToken = signAttestation(claims(signer, { verdict: "fail" }), signer);
  const [h, , s] = failToken.split(".");
  const forgedPayload = Buffer.from(JSON.stringify(claims(signer, { verdict: "pass" }))).toString("base64url");
  assert.equal(
    verifyToken({
      token: `${h}.${forgedPayload}.${s}`,
      actualTreeSha: TREE,
      expectedProject: PROJECT,
      pems: [signer.publicKeyPem],
      now: NOW,
    }).reason,
    FAIL.BAD_SIGNATURE,
  );

  // A valid token but verified against an unrelated key.
  const passToken = signAttestation(claims(signer), signer);
  const { privateKey: other } = generateKeyPairSync("ed25519");
  const otherPub = createPublicKey(other).export({ type: "spki", format: "pem" }).toString();
  assert.equal(
    verifyToken({ token: passToken, actualTreeSha: TREE, expectedProject: PROJECT, pems: [otherPub], now: NOW }).reason,
    FAIL.BAD_SIGNATURE,
  );
});

test("action verifier selects the right key by kid during rotation", async () => {
  const { verifyToken } = (await import(verifyModUrl)) as VerifyMod;
  const signer = buildAttestSigner({
    signingKey: testKeyPem(),
    keyId: "rp-new",
    enforce: "warn",
    blockSeverity: "major",
    ttlMs: 60_000,
  })!;
  const token = signAttestation(claims(signer), signer);
  const { privateKey: old } = generateKeyPairSync("ed25519");
  const oldPub = createPublicKey(old).export({ type: "spki", format: "pem" }).toString();
  // Both an old and the new key are configured; kid must pick the new one.
  const r = verifyToken({
    token,
    actualTreeSha: TREE,
    expectedProject: PROJECT,
    pems: [oldPub, signer.publicKeyPem],
    pemByKid: { "rp-old": oldPub, "rp-new": signer.publicKeyPem },
    now: NOW,
  });
  assert.equal(r.ok, true);
});
