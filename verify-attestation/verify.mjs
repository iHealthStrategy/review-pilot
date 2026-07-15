// Offline verifier for ReviewPilot commit attestations, run inside GitHub
// Actions. It reads the `Reviewed-Token` trailer from a commit, verifies the
// Ed25519 signature with a PRE-CONFIGURED public key (NO network — CI never
// calls the ReviewPilot server), and confirms the token actually covers THIS
// commit's code (tree sha), THIS repo (project), is unexpired, and passed.
//
// This is intentionally self-contained (Node built-ins only) so the action runs
// with zero install. The crypto + claim checks MUST stay byte-for-byte
// compatible with packages/server/src/auth/attestation.ts — a server test
// (attestation-action.test.ts) imports this file and cross-checks them so they
// can't drift.

import crypto from "node:crypto";
import fs from "node:fs";

/**
 * The set of failure reasons, so callers (and tests) can assert on a stable
 * enum rather than message text.
 */
export const FAIL = {
  NO_TOKEN: "no-token",
  MALFORMED: "malformed-token",
  BAD_SIGNATURE: "bad-signature",
  EXPIRED: "expired",
  BAD_VERSION: "unsupported-version",
  TREE_MISMATCH: "tree-mismatch",
  PROJECT_MISMATCH: "project-mismatch",
  VERDICT_FAIL: "verdict-fail",
};

/** base64url → utf8 JSON parse, or null on any error. */
function decodeJson(part) {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Try to verify the compact EdDSA JWS signing input against any of the provided
 * PEM public keys. Returns true on the first that verifies.
 */
function signatureValid(signingInput, sigB64, pems) {
  const sig = Buffer.from(sigB64, "base64url");
  const data = Buffer.from(signingInput);
  for (const pem of pems) {
    if (!pem) continue;
    try {
      if (crypto.verify(null, data, crypto.createPublicKey(pem), sig)) return true;
    } catch {
      // wrong/garbage key — try the next
    }
  }
  return false;
}

/**
 * Verify a token against the expected commit + project. Pure and synchronous so
 * it is trivially unit-testable.
 *
 * @param {object} o
 * @param {string} o.token           the `Reviewed-Token` trailer value ("" when absent)
 * @param {string} o.actualTreeSha   `git rev-parse <sha>^{tree}` of the checked commit
 * @param {string} o.expectedProject normalized project key, e.g. github.com/acme/app
 * @param {string[]} o.pems          candidate public keys (kid-selected first, else all)
 * @param {Record<string,string>} [o.pemByKid] optional kid→PEM map for rotation
 * @param {number} o.now             epoch ms (for expiry)
 * @returns {{ok: boolean, reason?: string, claims?: object}}
 */
export function verifyToken({ token, actualTreeSha, expectedProject, pems, pemByKid, now }) {
  if (!token) return { ok: false, reason: FAIL.NO_TOKEN };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: FAIL.MALFORMED };
  const [header, payload, sig] = parts;
  const head = decodeJson(header);
  if (!head || head.alg !== "EdDSA") return { ok: false, reason: FAIL.MALFORMED };

  // Prefer the key matching the token's kid; fall back to every configured key
  // (covers a single-key setup and the rotation overlap window).
  const candidates = [];
  if (pemByKid && head.kid && pemByKid[head.kid]) candidates.push(pemByKid[head.kid]);
  for (const p of pems) if (!candidates.includes(p)) candidates.push(p);

  if (!signatureValid(`${header}.${payload}`, sig, candidates)) {
    return { ok: false, reason: FAIL.BAD_SIGNATURE };
  }

  const claims = decodeJson(payload);
  if (!claims) return { ok: false, reason: FAIL.MALFORMED };
  if (claims.v !== 1) return { ok: false, reason: FAIL.BAD_VERSION, claims };
  if (typeof claims.exp !== "number" || claims.exp < now) {
    return { ok: false, reason: FAIL.EXPIRED, claims };
  }
  // THE binding: the token must cover the code that is actually being merged.
  if (!claims.treeSha || claims.treeSha !== actualTreeSha) {
    return { ok: false, reason: FAIL.TREE_MISMATCH, claims };
  }
  // Scope the token to this repo so it can't be replayed from another project.
  if (expectedProject && claims.project !== expectedProject) {
    return { ok: false, reason: FAIL.PROJECT_MISMATCH, claims };
  }
  if (claims.verdict !== "pass") return { ok: false, reason: FAIL.VERDICT_FAIL, claims };
  return { ok: true, claims };
}

/** Human-readable one-liner for a failure reason. */
export function explain(reason, claims) {
  switch (reason) {
    case FAIL.NO_TOKEN:
      return "no Reviewed-Token trailer on the head commit — run the ReviewPilot skill and amend before pushing";
    case FAIL.MALFORMED:
      return "the attestation token is malformed";
    case FAIL.BAD_SIGNATURE:
      return "the attestation signature is invalid (wrong key, or the token was tampered with)";
    case FAIL.EXPIRED:
      return "the attestation has expired — re-run the review to refresh it";
    case FAIL.BAD_VERSION:
      return "unsupported attestation version";
    case FAIL.TREE_MISMATCH:
      return "the attestation does not match the current code (tree changed after review) — re-run the review on the final commit";
    case FAIL.PROJECT_MISMATCH:
      return `the attestation is for a different project (${claims?.project ?? "?"})`;
    case FAIL.VERDICT_FAIL:
      return "the review did NOT pass the policy — fix the reported must-fix findings and re-run";
    default:
      return "attestation verification failed";
  }
}

// --- CLI entry: read env, verify, set outputs, exit 0/1 --------------------
// Only runs when executed directly (not when imported by tests).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const env = process.env;
  const token = (env.RP_TOKEN ?? "").trim();
  const actualTreeSha = (env.RP_TREE_SHA ?? "").trim();
  const expectedProject = (env.RP_EXPECTED_PROJECT ?? "").trim().toLowerCase();
  const required = (env.RP_REQUIRE ?? "true").toLowerCase() !== "false";

  // Public keys: RP_PUBLIC_KEYS (JSON kid→PEM) takes precedence; else RP_PUBLIC_KEY (single PEM).
  let pemByKid;
  const pems = [];
  if (env.RP_PUBLIC_KEYS) {
    try {
      pemByKid = JSON.parse(env.RP_PUBLIC_KEYS);
      for (const v of Object.values(pemByKid)) if (typeof v === "string") pems.push(v);
    } catch {
      console.error("::error::RP_PUBLIC_KEYS is not valid JSON");
      process.exit(1);
    }
  }
  if (env.RP_PUBLIC_KEY) pems.push(env.RP_PUBLIC_KEY);
  if (pems.length === 0) {
    console.error("::error::no public key configured (set public-key or public-keys)");
    process.exit(1);
  }

  const now = Number(env.RP_NOW) || Date.now();
  const result = verifyToken({ token, actualTreeSha, expectedProject, pems, pemByKid, now });

  // Synchronous writes: process.exit() below must not race the file append.
  const setOutput = (k, v) => {
    if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `${k}=${v}\n`);
  };
  const summary = (line) => {
    if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, line + "\n");
  };

  if (result.ok) {
    const c = result.claims;
    const msg = `ReviewPilot attestation OK — reviewed by @${c.handle}, verdict=pass, policy=${c.policy}`;
    console.log(msg);
    summary(`### ✅ ReviewPilot attestation verified\n- reviewer: @${c.handle}\n- verdict: \`pass\` (policy: \`${c.policy}\`)\n- tree: \`${c.treeSha}\``);
    setOutput("verdict", "pass");
    setOutput("handle", c.handle ?? "");
    process.exit(0);
  }

  // No token + not required → soft pass (advisory mode).
  if (result.reason === FAIL.NO_TOKEN && !required) {
    console.log("::warning::no ReviewPilot attestation found (not required) — allowing");
    summary("### ⚠️ ReviewPilot attestation missing (not required) — allowed");
    setOutput("verdict", "skipped");
    process.exit(0);
  }

  const why = explain(result.reason, result.claims);
  console.error(`::error::ReviewPilot attestation failed: ${why}`);
  summary(`### ❌ ReviewPilot attestation failed\n- reason: \`${result.reason}\`\n- ${why}`);
  setOutput("verdict", "fail");
  setOutput("reason", result.reason ?? "");
  process.exit(1);
}
