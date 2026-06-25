import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A user's dedicated "skill access token": a stable, DERIVED credential of the
 * form `rsk_<userId>.<hmac>` where the signature is HMAC-SHA256(secret,
 * "skill:"+userId). Because it is derived (not stored), every user implicitly
 * has exactly one, old users included — there is nothing to create and nothing
 * to delete. It is retrievable at any time for the authenticated owner, so the
 * skill-install command always carries a real token. It authenticates as the
 * user (same role) wherever a PAT does.
 *
 * Trade-off: it is not individually revocable — rotating the server `secret`
 * rotates ALL skill tokens (and sessions). Acceptable because the product
 * requirement is an always-present, non-deletable token; per-user revocation
 * would need a stored per-user nonce in the HMAC input.
 */
export const SKILL_TOKEN_PREFIX = "rsk_";

function sign(userId: string, secret: string): string {
  return createHmac("sha256", secret).update("skill:" + userId).digest("base64url");
}

/** Derive the skill token for a user. Returns "" when no secret is configured. */
export function skillTokenFor(userId: string, secret: string): string {
  if (!secret || !userId) return "";
  return `${SKILL_TOKEN_PREFIX}${userId}.${sign(userId, secret)}`;
}

export function looksLikeSkillToken(credential: string): boolean {
  return credential.startsWith(SKILL_TOKEN_PREFIX);
}

/** Verify a presented skill token; returns the userId it authenticates, or null. */
export function verifySkillToken(credential: string, secret: string): string | null {
  if (!secret || !looksLikeSkillToken(credential)) return null;
  const rest = credential.slice(SKILL_TOKEN_PREFIX.length);
  const dot = rest.lastIndexOf(".");
  if (dot <= 0) return null;
  const userId = rest.slice(0, dot);
  const sig = rest.slice(dot + 1);
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(userId, secret));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return userId;
}
