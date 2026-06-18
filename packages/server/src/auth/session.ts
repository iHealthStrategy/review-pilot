import { createHmac, timingSafeEqual } from "node:crypto";
import type { UserRole } from "../domain/entities.js";

/**
 * Minimal HMAC-SHA256 signed session token in JWT-compatible form
 * (`base64url(header).base64url(payload).base64url(sig)`), implemented with
 * node:crypto so we add no dependency. It proves identity + expiry only; the
 * caller re-reads the user's current role from the store, so role changes take
 * effect immediately rather than waiting for the token to expire.
 */
export interface SessionClaims {
  /** User id. */
  sub: string;
  role: UserRole;
  /** Issued-at / expiry, in epoch seconds. */
  iat: number;
  exp: number;
}

const HEADER = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function signSession(
  claims: { sub: string; role: UserRole },
  secret: string,
  ttlMs: number,
  now: number = Date.now(),
): string {
  const iat = Math.floor(now / 1000);
  const exp = iat + Math.floor(ttlMs / 1000);
  const payload = Buffer.from(JSON.stringify({ ...claims, iat, exp })).toString("base64url");
  const input = `${HEADER}.${payload}`;
  return `${input}.${sign(input, secret)}`;
}

export function verifySession(
  token: string,
  secret: string,
  now: number = Date.now(),
): SessionClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts as [string, string, string];
  const expected = sign(`${header}.${payload}`, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let claims: SessionClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SessionClaims;
  } catch {
    return null;
  }
  if (typeof claims.sub !== "string" || !claims.sub) return null;
  if (typeof claims.exp !== "number" || Math.floor(now / 1000) >= claims.exp) return null;
  return claims;
}
