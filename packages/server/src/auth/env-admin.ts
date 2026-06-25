import { timingSafeEqual } from "node:crypto";

/**
 * A built-in admin configured purely from the environment — it is NOT stored in
 * the database and needs no maintenance. It exists to bootstrap/operate the
 * system (and as a break-glass admin) without depending on any registered user.
 * Enabled only when a password is set; the email defaults but can be overridden.
 */
export const ENV_ADMIN_ID = "usr_env_admin";

export interface EnvAdmin {
  id: string;
  email: string;
  password: string;
  /**
   * Optional config-only personal access token. When set, a request bearing
   * this token authenticates as the env admin (admin role) — no DB row needed,
   * so the env admin can drive the API/MCP/skill-auto-grow without registering.
   * Break-glass like the password: keep it long, random, and secret-managed.
   */
  token: string;
}

/** Build the env admin, or null when no password is configured (disabled). */
export function envAdminFrom(email: string, password: string, token = ""): EnvAdmin | null {
  if (!password) return null;
  return { id: ENV_ADMIN_ID, email: email.trim().toLowerCase(), password, token };
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** This (already-normalized) email belongs to the configured env admin. */
export function isEnvAdminEmail(admin: EnvAdmin | null, normalizedEmail: string): boolean {
  return !!admin && safeEqual(normalizedEmail, admin.email);
}

/** The credentials match the configured env admin (constant-time on the password). */
export function matchesEnvAdmin(
  admin: EnvAdmin | null,
  normalizedEmail: string,
  password: string,
): boolean {
  if (!admin) return false;
  return safeEqual(normalizedEmail, admin.email) && safeEqual(password, admin.password);
}

/** A presented bearer credential equals the env admin's configured token (constant-time). */
export function matchesEnvAdminToken(admin: EnvAdmin | null, credential: string): boolean {
  if (!admin || !admin.token) return false;
  return safeEqual(credential, admin.token);
}
