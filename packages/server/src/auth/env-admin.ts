import { timingSafeEqual } from "node:crypto";

/**
 * A built-in admin configured purely from the environment — NOT stored in the
 * database and needs no maintenance. It is a TOKEN-ONLY break-glass admin for
 * the API/MCP (interactive login is delegated to the OIDC provider; the env
 * admin has no password login). Enabled only when `ADMIN_TOKEN` is set.
 */
export const ENV_ADMIN_ID = "usr_env_admin";

export interface EnvAdmin {
  id: string;
  email: string;
  /**
   * Config-only personal access token. A request bearing this token
   * authenticates as the env admin (admin role) — no DB row needed, so the env
   * admin can drive the API/MCP/skill-auto-grow and bootstrap roles without an
   * IdP account. Break-glass: keep it long, random, and secret-managed.
   */
  token: string;
}

/** Build the env admin, or null when no token is configured (disabled). */
export function envAdminFrom(email: string, token: string): EnvAdmin | null {
  if (!token) return null;
  return { id: ENV_ADMIN_ID, email: email.trim().toLowerCase(), token };
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** A presented bearer credential equals the env admin's configured token (constant-time). */
export function matchesEnvAdminToken(admin: EnvAdmin | null, credential: string): boolean {
  if (!admin || !admin.token) return false;
  return safeEqual(credential, admin.token);
}
