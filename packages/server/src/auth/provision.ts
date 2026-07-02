import type { User, UserRole } from "../domain/entities.js";
import type { Repository } from "../persistence/repository.js";
import { slugify } from "../skill/review-skill.js";
import type { OidcIdentity } from "./oidc.js";

/** Derive a candidate public handle from an email local-part (or any seed). */
export function handleFromEmail(seed: string): string {
  return slugify((seed || "user").split("@")[0] ?? "user");
}

/**
 * Generate a unique handle from a seed, appending `-N` on collision against
 * existing DB users or the supplied reserved set (e.g. the env admin's handle).
 */
export async function generateHandle(
  seed: string,
  repo: Repository,
  reserved: readonly string[],
): Promise<string> {
  const base = handleFromEmail(seed);
  let candidate = base;
  let n = 2;
  while (reserved.includes(candidate) || (await repo.getUserByHandle(candidate))) {
    candidate = `${base}-${n++}`;
  }
  return candidate;
}

/**
 * Resolve the local account for an authenticated OIDC identity, creating or
 * linking on demand (the IdP owns authentication; this table only carries role
 * config + community identity):
 *   1. matched by external subject (`sub`) → return it;
 *   2. else matched by email → link the subject to that existing account;
 *   3. else create a fresh account, seeding the role from the caller's groups.
 *
 * The group→role mapping seeds the role ONLY at creation. Afterwards the local
 * role is authoritative (admins manage it in the UI), so a manual change is
 * never overwritten by a later login.
 */
export async function provisionUser(
  repo: Repository,
  identity: OidcIdentity,
  seedRole: UserRole,
): Promise<User> {
  const byExternal = await repo.getUserByExternalId(identity.sub);
  if (byExternal) return byExternal;
  if (identity.email) {
    const byEmail = await repo.getUserByEmail(identity.email);
    if (byEmail) return repo.setUserExternalId(byEmail.id, identity.sub);
  }
  const seed = identity.preferredUsername || identity.email || identity.sub;
  const handle = await generateHandle(seed, repo, []);
  return repo.createUser({
    email: identity.email,
    handle,
    externalId: identity.sub,
    role: seedRole,
  });
}

/**
 * Resolve the account for a login. Always provisions (create/link). When
 * `syncRoles` is set, the IdP is authoritative: the role is forced to
 * `groupRole` on every login (so group changes take effect and demotions
 * apply). Otherwise `groupRole` only seeds a newly-created account and the
 * stored role is preserved.
 */
export async function loginUser(
  repo: Repository,
  identity: OidcIdentity,
  groupRole: UserRole,
  syncRoles: boolean,
): Promise<User> {
  const user = await provisionUser(repo, identity, groupRole);
  if (syncRoles && user.role !== groupRole) {
    return repo.updateUserRole(user.id, groupRole);
  }
  return user;
}
