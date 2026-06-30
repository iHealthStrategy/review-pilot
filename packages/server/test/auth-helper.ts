import type { User, UserRole } from "../src/domain/entities.js";
import type { Repository } from "../src/persistence/repository.js";
import { signSession } from "../src/auth/session.js";

let seq = 0;

/**
 * Create a DB user and a Bearer session token for it — the test-time equivalent
 * of a completed OIDC login (the provider is mocked away). Authentication is no
 * longer done in-app, so tests mint their own sessions against the same secret.
 */
export async function makeSession(
  repo: Repository,
  secret: string,
  role: UserRole,
  opts: { email?: string; handle?: string; externalId?: string } = {},
): Promise<{ user: User; token: string }> {
  seq += 1;
  const user = await repo.createUser({
    email: opts.email ?? `u${seq}@x.com`,
    handle: opts.handle ?? `u${seq}`,
    externalId: opts.externalId ?? `ext-${seq}`,
    role,
  });
  const token = signSession({ sub: user.id, role: user.role }, secret, 3_600_000);
  return { user, token };
}
