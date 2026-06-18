import { createHash, randomBytes } from "node:crypto";

/**
 * Personal access tokens (PATs). The plaintext `secret` is shown to the user
 * once; only its SHA-256 `tokenHash` is persisted, so a leaked store can't be
 * replayed. `prefix` is the non-secret leading part kept for display.
 */
const PREFIX = "rpat_";

export interface GeneratedToken {
  /** Plaintext secret — returned to the user exactly once. */
  secret: string;
  tokenHash: string;
  prefix: string;
}

export function generateApiToken(): GeneratedToken {
  const secret = PREFIX + randomBytes(24).toString("hex");
  return {
    secret,
    tokenHash: hashApiToken(secret),
    prefix: secret.slice(0, 12),
  };
}

export function hashApiToken(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** A presented credential is a PAT (vs a session token) iff it has our prefix. */
export function looksLikeApiToken(credential: string): boolean {
  return credential.startsWith(PREFIX);
}
