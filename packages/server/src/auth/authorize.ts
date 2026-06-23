import type { UserRole } from "../domain/entities.js";
import type { Repository } from "../persistence/repository.js";
import { type EnvAdmin, ENV_ADMIN_ID } from "./env-admin.js";
import { verifySession } from "./session.js";
import { hashApiToken, looksLikeApiToken } from "./tokens.js";

/** The authenticated caller, resolved from a session token or a PAT. */
export interface Principal {
  userId: string;
  role: UserRole;
  via: "session" | "token";
}

const RANK: Record<UserRole, number> = { viewer: 1, member: 2, admin: 3 };

/** True when `role` is at least as privileged as `min`. */
export function roleAtLeast(role: UserRole, min: UserRole): boolean {
  return RANK[role] >= RANK[min];
}

/**
 * Minimum role for a request, or "public" for unauthenticated routes. The role
 * is always re-read from the store (not trusted from the token), so an admin's
 * role change takes effect on the next request.
 */
export function requiredRole(method: string, pathname: string): UserRole | "public" {
  if (pathname === "/api/health") return "public";
  if (pathname === "/api/auth/register" || pathname === "/api/auth/login") return "public";
  // User administration is admin-only.
  if (pathname === "/api/users" || pathname.startsWith("/api/users/")) return "admin";
  // Self-service (own identity, own tokens, own rulesets) needs only auth.
  // Ownership is enforced per-handler; viewers may manage their own content.
  if (
    pathname === "/api/auth/me" ||
    pathname === "/api/auth/logout" ||
    pathname === "/api/tokens" ||
    pathname.startsWith("/api/tokens/") ||
    pathname === "/api/rulesets" ||
    pathname.startsWith("/api/rulesets/")
  ) {
    return "viewer";
  }
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD" ? "viewer" : "member";
}

/**
 * Resolve an Authorization header to a {@link Principal}, or null when absent/
 * invalid. Accepts either a PAT (`rpat_…`) or a session token; in both cases the
 * user's CURRENT role is loaded from the store.
 */
export async function resolvePrincipal(
  authorization: string | undefined,
  repo: Repository,
  secret: string,
  envAdmin: EnvAdmin | null = null,
  now: number = Date.now(),
): Promise<Principal | null> {
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match) return null;
  const credential = match[1]!.trim();

  if (looksLikeApiToken(credential)) {
    const record = await repo.getApiTokenByHash(hashApiToken(credential));
    if (!record) return null;
    const user = await repo.getUserById(record.userId);
    if (!user) return null;
    void repo.touchApiToken(record.id, new Date(now).toISOString()).catch(() => {});
    return { userId: user.id, role: user.role, via: "token" };
  }

  const claims = verifySession(credential, secret, now);
  if (!claims) return null;
  // The env admin is not in the database; resolve it from config alone.
  if (envAdmin && claims.sub === ENV_ADMIN_ID) {
    return { userId: ENV_ADMIN_ID, role: "admin", via: "session" };
  }
  const user = await repo.getUserById(claims.sub);
  if (!user) return null;
  return { userId: user.id, role: user.role, via: "session" };
}
