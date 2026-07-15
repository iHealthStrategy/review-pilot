import {
  createHash,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  sign as edSign,
  verify as edVerify,
} from "node:crypto";
import type { Severity } from "../domain/entities.js";
import { SEVERITY_RANK } from "../review/severity.js";

/**
 * Review ATTESTATIONS — the anti-forgery core of the "review ran locally, gate
 * enforced remotely" flow.
 *
 * The server holds an Ed25519 PRIVATE key and signs a small claims object that
 * binds a review verdict to a specific code snapshot (the commit's TREE sha, not
 * its commit sha — see below). GitHub Actions holds only the PUBLIC key and
 * verifies the token OFFLINE, so CI never has to reach back to this service.
 * Developers hold neither key, so they can neither forge a token nor flip a
 * verdict — that is the whole point.
 *
 * Why bind the TREE sha, not the commit sha: the developer writes the token back
 * into the commit as a `Reviewed-Token` trailer. Adding a trailer rewrites the
 * commit message → the commit sha changes, but the tree (the code snapshot) does
 * NOT. So the CI check `token.treeSha === headCommit.treeSha` holds after the
 * amend, yet breaks the instant any file content changes. That is exactly the
 * property we want: the attestation covers the code that ships, and re-review is
 * forced whenever the code moves.
 *
 * Format: a dependency-free compact JWS, `b64url(header).b64url(payload).
 * b64url(sig)`, mirroring {@link ../auth/session.ts} but with alg=EdDSA and a
 * `kid` so the public key can be rotated.
 */

export type AttestEnforce = "off" | "warn" | "block";

export interface AttestFindings {
  critical: number;
  major: number;
  minor: number;
  info: number;
}

/** The signed claims. Every field is verified by the CI action before merge. */
export interface AttestClaims {
  /** Schema version (bump on any breaking claim change). */
  v: 1;
  /** Normalized project key, e.g. `github.com/acme/app` — scopes the token. */
  project: string;
  /** The reviewed commit's tree sha (code snapshot the verdict covers). */
  treeSha: string;
  /** The PR base sha, when known — lets CI confirm the diff range. */
  baseSha?: string;
  /** How the diff was gathered locally. */
  scope: "working" | "branch" | "whole" | "commit";
  /** Finding counts by severity (all of them, regardless of display threshold). */
  findings: AttestFindings;
  /** Server-decided outcome under the current policy. */
  verdict: "pass" | "fail";
  /** The enforcement policy in effect when signed (audit trail). */
  policy: AttestEnforce;
  /** The severity at/above which findings block, under `policy: block`. */
  blockSeverity: Severity;
  /** Subject — the reviewing user's id. */
  sub: string;
  /** The reviewing user's public handle (display/audit). */
  handle: string;
  /** Issued-at (epoch ms). */
  iat: number;
  /** Expiry (epoch ms) — keep short so a stale pass can't be reused. */
  exp: number;
  /** Key id of the signing key, for public-key rotation. */
  kid: string;
}

/** A ready-to-use signer, built once from config (null when unconfigured). */
export interface AttestSigner {
  readonly privateKey: KeyObject;
  readonly publicKeyPem: string;
  readonly kid: string;
  readonly enforce: AttestEnforce;
  readonly blockSeverity: Severity;
  readonly ttlMs: number;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** Derive a stable, short key id from the public key (SHA-256 of its DER). */
export function deriveKid(publicKey: KeyObject): string {
  const der = publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex").slice(0, 12);
}

/**
 * Build a signer from the raw config, or return null when no signing key is set
 * (attestation issuance is then disabled and the endpoints answer 503). Throws
 * only when a key IS provided but is malformed — fail fast at startup.
 */
export function buildAttestSigner(cfg: {
  signingKey: string;
  keyId: string;
  enforce: AttestEnforce;
  blockSeverity: Severity;
  ttlMs: number;
}): AttestSigner | null {
  if (!cfg.signingKey) return null;
  const privateKey = createPrivateKey(cfg.signingKey);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `ATTEST_SIGNING_KEY must be an Ed25519 private key, got ${privateKey.asymmetricKeyType ?? "unknown"}`,
    );
  }
  const publicKey = createPublicKey(privateKey);
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return {
    privateKey,
    publicKeyPem,
    kid: cfg.keyId || deriveKid(publicKey),
    enforce: cfg.enforce,
    blockSeverity: cfg.blockSeverity,
    ttlMs: cfg.ttlMs,
  };
}

/**
 * Decide the verdict for a set of finding counts under a policy. Only `block`
 * can ever fail; `off`/`warn` always pass (the finding list is still carried in
 * the token, so a warn policy surfaces issues without gating the merge).
 */
export function deriveVerdict(
  findings: AttestFindings,
  enforce: AttestEnforce,
  blockSeverity: Severity,
): "pass" | "fail" {
  if (enforce !== "block") return "pass";
  const threshold = SEVERITY_RANK[blockSeverity];
  const atOrAbove = (["critical", "major", "minor", "info"] as const)
    .filter((s) => SEVERITY_RANK[s] >= threshold)
    .reduce((sum, s) => sum + (findings[s] || 0), 0);
  return atOrAbove > 0 ? "fail" : "pass";
}

/** Sign a claims object into a compact EdDSA JWS. */
export function signAttestation(claims: AttestClaims, signer: AttestSigner): string {
  const header = b64url(JSON.stringify({ alg: "EdDSA", typ: "RPATT", kid: signer.kid }));
  const payload = b64url(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  const sig = edSign(null, Buffer.from(signingInput), signer.privateKey).toString("base64url");
  return `${signingInput}.${sig}`;
}

/**
 * Verify a token against a public key and return its claims, or null when the
 * signature is invalid, the token is malformed, or it has expired. Exported so
 * the CI action and unit tests share the EXACT verification path the server
 * intends (no drift between issuer and verifier).
 */
export function verifyAttestation(
  token: string,
  publicKeyPem: string,
  now: number = Date.now(),
): AttestClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts as [string, string, string];
  let ok = false;
  try {
    ok = edVerify(
      null,
      Buffer.from(`${header}.${payload}`),
      createPublicKey(publicKeyPem),
      Buffer.from(sig, "base64url"),
    );
  } catch {
    return null;
  }
  if (!ok) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AttestClaims;
    if (typeof claims.exp !== "number" || claims.exp < now) return null;
    if (claims.v !== 1) return null;
    return claims;
  } catch {
    return null;
  }
}
