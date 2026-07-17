import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type {
  ApiToken,
  Platform,
  ReviewEngineKind,
  User,
  UserRole,
} from "../domain/entities.js";
import { EntityNotFoundError, type Repository } from "../persistence/repository.js";
import {
  type Principal,
  requiredRole,
  resolvePrincipal,
  roleAtLeast,
} from "../auth/authorize.js";
import { generateApiToken } from "../auth/tokens.js";
import { skillTokenFor } from "../auth/skill-token.js";
import {
  type AttestClaims,
  type AttestEnforce,
  type AttestSigner,
  buildAttestSigner,
  deriveVerdict,
  signAttestation,
} from "../auth/attestation.js";
import type { AttestPolicyStore } from "../attest/policy-store.js";
import type { Severity } from "../domain/entities.js";
import { handleFromEmail } from "../auth/provision.js";
import { type Bucket, aggregateSkillByUser, aggregateUsage, defaultSince } from "../usage/aggregate.js";
import { normalizeProjectKey, slugify } from "../skill/review-skill.js";
import type { ReviewRule, RulesetVisibility } from "../domain/entities.js";
import type { UpdateRulesetPatch } from "../persistence/repository.js";
import { type EnvAdmin, ENV_ADMIN_ID, envAdminFrom } from "../auth/env-admin.js";
import type { ReviewTaskInput, TaskService } from "../trigger/trigger-service.js";
import type {
  CreateScheduleInput,
  DeliveryConfig,
  ScheduleStore,
  UpdateScheduleInput,
} from "../schedule/schedule.js";
import { ScheduleNotFoundError } from "../schedule/schedule.js";
import type { Scheduler } from "../schedule/scheduler.js";
import { parseTimeOfDay } from "../schedule/tz.js";

const PLATFORMS: readonly Platform[] = ["github", "gitlab"];
const ENGINES: readonly ReviewEngineKind[] = [
  "mock",
  "cursor",
  "claude-code",
  "claude-agent",
  "codex",
];

interface ApiResult {
  status: number;
  body: unknown;
}

/** Signing config threaded into auth handlers via the request context. */
interface AuthConfig {
  secret: string;
  sessionTtlMs: number;
  /** Built-in env-configured admin (not in the DB), or null when disabled. */
  envAdmin: EnvAdmin | null;
  /** When true, roles are synced from the IdP → local role editing is disabled. */
  rolesManagedExternally: boolean;
}

/** Public user view for the env admin (synthetic; no DB timestamps). */
function envAdminUser(admin: EnvAdmin) {
  return {
    id: admin.id,
    email: admin.email,
    handle: handleFromEmail(admin.email),
    name: "Env Admin",
    role: "admin" as const,
    createdAt: "",
    updatedAt: "",
  };
}

type Handler = (
  ctx: {
    params: Record<string, string>;
    body: unknown;
    query: URLSearchParams;
    /** The authenticated caller, or null (absent/invalid credential, or auth off). */
    principal: Principal | null;
    auth: AuthConfig;
    /** Review-attestation signer, or null when no signing key is configured. */
    attest: AttestSigner | null;
    /** Runtime attestation policy store (Web-UI managed), or null when absent. */
    attestPolicy: AttestPolicyStore | null;
  },
  repo: Repository,
  tasks: TaskService | undefined,
  schedules: ScheduleStore | undefined,
  scheduler: Scheduler | undefined,
) => Promise<ApiResult>;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function ok(body: unknown, status = 200): ApiResult {
  return { status, body };
}

function asString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new HttpError(400, `field '${field}' must be a non-empty string`);
  }
  return v;
}

function asEnum<T extends string>(v: unknown, allowed: readonly T[], field: string): T {
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    throw new HttpError(400, `field '${field}' must be one of ${allowed.join(", ")}`);
  }
  return v as T;
}

/** Validate a callback spec: { url, headers? }. */
function parseCallback(v: unknown): { url: string; headers?: Record<string, string> } {
  const c = (v ?? {}) as Record<string, unknown>;
  const url = asString(c.url, "callback.url");
  const headers: Record<string, string> = {};
  if (c.headers && typeof c.headers === "object") {
    for (const [k, val] of Object.entries(c.headers as Record<string, unknown>)) {
      if (typeof val === "string") headers[k] = val;
    }
  }
  return Object.keys(headers).length ? { url, headers } : { url };
}

const ROLES: readonly UserRole[] = ["viewer", "member", "admin"];
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** API-safe user view. */
function publicUser(u: User) {
  return {
    id: u.id,
    email: u.email,
    handle: u.handle,
    name: u.name,
    role: u.role,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}
/** API-safe token view — never leaks the token hash. */
function publicToken(t: ApiToken) {
  return {
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    createdAt: t.createdAt,
    ...(t.lastUsedAt ? { lastUsedAt: t.lastUsedAt } : {}),
  };
}

function requirePrincipal(principal: Principal | null): Principal {
  if (!principal) throw new HttpError(401, "unauthorized");
  return principal;
}

/** Resolve a principal's email for display/ownership (env admin or DB user). */
async function principalEmail(
  p: Principal,
  repo: Repository,
  auth: AuthConfig,
): Promise<string> {
  if (p.userId === ENV_ADMIN_ID && auth.envAdmin) return auth.envAdmin.email;
  const user = await repo.getUserById(p.userId);
  return user?.email ?? p.userId;
}

function asVisibility(v: unknown): RulesetVisibility {
  return v === "public" ? "public" : "private";
}

/** Resolve a principal's public handle (env admin or DB user). */
async function principalHandle(
  p: Principal,
  repo: Repository,
  auth: AuthConfig,
): Promise<string> {
  if (p.userId === ENV_ADMIN_ID && auth.envAdmin) return handleFromEmail(auth.envAdmin.email);
  const user = await repo.getUserById(p.userId);
  return user?.handle ?? "";
}

/**
 * Coerce request `rules` into validated ReviewRule[] (selectors default to []).
 * The per-rule `pending` and `disabled` flags are honoured so the UI can promote
 * a legacy pending rule (clear `pending`) or toggle a rule off (`disabled`).
 * `forcePending` is retained for legacy callers but is no longer used by the
 * auto-grow candidate path, which now stores rules in effect by default.
 */
function parseRules(v: unknown, forcePending = false): ReviewRule[] {
  if (!Array.isArray(v)) return [];
  const asStrArray = (x: unknown): string[] =>
    Array.isArray(x) ? x.filter((s): s is string => typeof s === "string" && s.length > 0) : [];
  const rules: ReviewRule[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const title = typeof r.title === "string" ? r.title.trim() : "";
    const instruction = typeof r.instruction === "string" ? r.instruction.trim() : "";
    if (!instruction) continue; // a rule with no instruction is meaningless
    rules.push({
      title: title || "Rule",
      instruction,
      globs: asStrArray(r.globs),
      languages: asStrArray(r.languages),
      topics: asStrArray(r.topics),
      ...(forcePending || r.pending === true ? { pending: true } : {}),
      ...(r.disabled === true ? { disabled: true } : {}),
    });
  }
  return rules;
}

const ROUTES: Route[] = [
  // --- Account (authentication is delegated to the OIDC provider; the login
  //     flow lives in app.ts at /api/auth/oidc/*) ---
  {
    method: "GET",
    pattern: /^\/api\/auth\/me$/,
    handler: async ({ principal, auth }, repo) => {
      const p = requirePrincipal(principal);
      const rolesManagedExternally = auth.rolesManagedExternally;
      if (p.userId === ENV_ADMIN_ID && auth.envAdmin) {
        return ok({ user: envAdminUser(auth.envAdmin), via: p.via, rolesManagedExternally });
      }
      const user = await repo.getUserById(p.userId);
      if (!user) throw new HttpError(401, "unauthorized");
      return ok({ user: publicUser(user), via: p.via, rolesManagedExternally });
    },
  },
  {
    // The caller's dedicated skill-access token (always available, non-deletable),
    // so the install command can always carry a real token. Env admin → the
    // configured ADMIN_TOKEN; a DB user → their derived rsk_ token.
    method: "GET",
    pattern: /^\/api\/auth\/skill-token$/,
    handler: async ({ principal, auth }) => {
      const p = requirePrincipal(principal);
      if (p.userId === ENV_ADMIN_ID) {
        const token = auth.envAdmin?.token ?? "";
        return ok({ kind: "admin", token, configured: token.length > 0 });
      }
      return ok({ kind: "user", token: skillTokenFor(p.userId, auth.secret), configured: true });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/auth\/logout$/,
    // Stateless: the client discards its token. Endpoint exists for symmetry.
    handler: async () => ok({ ok: true }),
  },
  // --- Review attestations (the local-review → remote-gate bridge) ---
  {
    // The public verification key. UNAUTHENTICATED by design: GitHub Actions
    // fetches it (or bakes it in) to verify tokens OFFLINE, so CI never has to
    // call any authenticated endpoint on this server. A public key is not secret.
    method: "GET",
    pattern: /^\/api\/attest\/pubkey$/,
    handler: async ({ attest, attestPolicy }) => {
      if (!attest) throw new HttpError(503, "attestation is not configured on this server");
      const policy = attestPolicy ? await attestPolicy.getGlobal() : null;
      return ok({
        kid: attest.kid,
        algorithm: "EdDSA",
        // Report the LIVE policy (Web-UI managed), falling back to the signer seed.
        enforce: policy?.enforce ?? attest.enforce,
        blockSeverity: policy?.blockSeverity ?? attest.blockSeverity,
        publicKey: attest.publicKeyPem,
      });
    },
  },
  {
    // View a policy (any authenticated user). `?project=<key>` returns the
    // EFFECTIVE policy for that project (its override if any, else the global,
    // with a `source` field); no query returns the global default.
    method: "GET",
    pattern: /^\/api\/attest\/policy$/,
    handler: async ({ attest, attestPolicy, query }) => {
      if (!attest) throw new HttpError(503, "attestation is not configured on this server");
      if (!attestPolicy) throw new HttpError(503, "attestation policy store not available");
      const project = normalizeProjectKey(query.get("project") ?? "");
      if (project) return ok(await attestPolicy.getEffective(project));
      return ok(await attestPolicy.getGlobal());
    },
  },
  {
    // The global default plus every per-project override (admin overview).
    method: "GET",
    pattern: /^\/api\/attest\/policies$/,
    handler: async ({ attest, attestPolicy }) => {
      if (!attest) throw new HttpError(503, "attestation is not configured on this server");
      if (!attestPolicy) throw new HttpError(503, "attestation policy store not available");
      return ok({
        global: await attestPolicy.getGlobal(),
        overrides: await attestPolicy.listOverrides(),
      });
    },
  },
  {
    // Remove a per-project override → that project falls back to the global
    // default. Admin-only (gated in requiredRole). Requires ?project=.
    method: "DELETE",
    pattern: /^\/api\/attest\/policy$/,
    handler: async ({ attest, attestPolicy, query }) => {
      if (!attest) throw new HttpError(503, "attestation is not configured on this server");
      if (!attestPolicy) throw new HttpError(503, "attestation policy store not available");
      const project = normalizeProjectKey(query.get("project") ?? "");
      if (!project) throw new HttpError(400, "provide ?project= to delete a per-project override");
      await attestPolicy.deleteOverride(project);
      return ok({ ok: true });
    },
  },
  {
    // Change the global enforcement policy — the Web-UI "是否强制修复" control.
    // Admin-only (gated in requiredRole): it governs whether merges are blocked.
    method: "PUT",
    pattern: /^\/api\/attest\/policy$/,
    handler: async ({ principal, body, attest, attestPolicy, auth }, repo) => {
      const p = requirePrincipal(principal);
      if (!attest) throw new HttpError(503, "attestation is not configured on this server");
      if (!attestPolicy) throw new HttpError(503, "attestation policy store not available");
      const b = (body ?? {}) as Record<string, unknown>;
      const patch: { enforce?: AttestEnforce; blockSeverity?: Severity } = {};
      if (b.enforce !== undefined) {
        patch.enforce = asEnum(b.enforce, ["off", "warn", "block"] as const, "enforce");
      }
      if (b.blockSeverity !== undefined) {
        patch.blockSeverity = asEnum(
          b.blockSeverity,
          ["info", "minor", "major", "critical"] as const,
          "blockSeverity",
        );
      }
      if (patch.enforce === undefined && patch.blockSeverity === undefined) {
        throw new HttpError(400, "provide 'enforce' and/or 'blockSeverity'");
      }
      // Empty/absent project → the global default; a key → a per-project override.
      const project = normalizeProjectKey(typeof b.project === "string" ? b.project : "");
      const handle = await principalHandle(p, repo, auth);
      const by = handle ? `@${handle}` : await principalEmail(p, repo, auth);
      return ok(await attestPolicy.set(patch, by, project));
    },
  },
  {
    // Issue a signed attestation for a locally-run review. The caller (the local
    // skill, authenticated as the reviewing user) sends the reviewed commit's
    // TREE sha + finding COUNTS (never code); the SERVER decides the verdict
    // under the current policy and signs it. The developer cannot influence the
    // verdict or forge the signature — the private key never leaves the server.
    method: "POST",
    pattern: /^\/api\/attest$/,
    handler: async ({ principal, body, attest, attestPolicy, auth }, repo) => {
      const p = requirePrincipal(principal);
      if (!attest) throw new HttpError(503, "attestation is not configured on this server");
      const b = (body ?? {}) as Record<string, unknown>;
      const project = normalizeProjectKey(asString(b.project, "project"));
      const treeSha = asString(b.treeSha, "treeSha");
      const scope = asEnum(b.scope, ["working", "branch", "whole", "commit"] as const, "scope");
      const count = (k: string): number => {
        const v = b[k];
        const n = typeof v === "number" ? v : Number(v);
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
      };
      const findings = {
        critical: count("critical"),
        major: count("major"),
        minor: count("minor"),
        info: count("info"),
      };
      // The enforcement policy is Web-UI managed at runtime; read it live per
      // request (fall back to the signer's env-seeded values if no store).
      const policy = attestPolicy
        ? await attestPolicy.getEffective(project)
        : { enforce: attest.enforce, blockSeverity: attest.blockSeverity };
      const verdict = deriveVerdict(findings, policy.enforce, policy.blockSeverity);
      const handle = await principalHandle(p, repo, auth);
      const now = Date.now();
      const claims: AttestClaims = {
        v: 1,
        project,
        treeSha,
        scope,
        findings,
        verdict,
        policy: policy.enforce,
        blockSeverity: policy.blockSeverity as Severity,
        sub: p.userId,
        handle,
        iat: now,
        exp: now + attest.ttlMs,
        kid: attest.kid,
        ...(typeof b.baseSha === "string" && b.baseSha ? { baseSha: b.baseSha } : {}),
      };
      const token = signAttestation(claims, attest);
      return ok(
        {
          token,
          verdict,
          policy: policy.enforce,
          blockSeverity: policy.blockSeverity,
          treeSha,
          expiresAt: new Date(claims.exp).toISOString(),
        },
        201,
      );
    },
  },
  // --- Personal access tokens (self-service) ---
  {
    method: "GET",
    pattern: /^\/api\/tokens$/,
    handler: async ({ principal }, repo) => {
      const p = requirePrincipal(principal);
      const tokens = await repo.listApiTokensByUser(p.userId);
      return ok(tokens.map(publicToken));
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/tokens$/,
    handler: async ({ principal, body }, repo) => {
      const p = requirePrincipal(principal);
      if (p.userId === ENV_ADMIN_ID) {
        throw new HttpError(
          400,
          "the bootstrap admin can't own personal tokens; create a regular user for automation",
        );
      }
      const name = asString((body as Record<string, unknown>)?.name, "name");
      const gen = generateApiToken();
      const rec = await repo.createApiToken({
        userId: p.userId,
        name,
        tokenHash: gen.tokenHash,
        prefix: gen.prefix,
      });
      // The plaintext secret is returned exactly once, here.
      return ok({ ...publicToken(rec), token: gen.secret }, 201);
    },
  },
  {
    method: "DELETE",
    pattern: /^\/api\/tokens\/(?<id>[^/]+)$/,
    handler: async ({ principal, params }, repo) => {
      const p = requirePrincipal(principal);
      await repo.deleteApiToken(params.id!, p.userId);
      return ok({ ok: true });
    },
  },
  // --- User administration (admin only; gated in createApiHandler) ---
  {
    method: "GET",
    pattern: /^\/api\/users$/,
    handler: async (_ctx, repo) => ok((await repo.listUsers()).map(publicUser)),
  },
  {
    method: "PATCH",
    pattern: /^\/api\/users\/(?<id>[^/]+)\/role$/,
    handler: async ({ params, body, auth }, repo) => {
      if (auth.rolesManagedExternally) {
        throw new HttpError(409, "roles are managed by the identity provider; change group membership there");
      }
      const role = asEnum((body as Record<string, unknown>)?.role, ROLES, "role");
      const user = await repo.updateUserRole(params.id!, role);
      return ok(publicUser(user));
    },
  },
  // --- Token usage (per-task LLM consumption, by day/week/month) ---
  {
    method: "GET",
    pattern: /^\/api\/usage$/,
    handler: async ({ query }, repo) => {
      const raw = query.get("bucket");
      const bucket: Bucket = raw === "week" || raw === "month" ? raw : "day";
      const source = query.get("source");
      const events = await repo.listTokenUsage({
        since: defaultSince(bucket),
        ...(source === "schedule" || source === "task" ? { source } : {}),
      });
      return ok({ bucket, rows: aggregateUsage(events, bucket) });
    },
  },
  // --- Skill usage: the local review skill reports each run (no token data).
  //     POST is self-service (any authenticated user, attributed to the caller).
  {
    method: "POST",
    pattern: /^\/api\/usage\/skill$/,
    handler: async ({ principal, body, auth }, repo) => {
      const p = requirePrincipal(principal);
      const b = (body ?? {}) as Record<string, unknown>;
      const scope = asEnum(b.scope, ["working", "branch", "whole"] as const, "scope");
      const count = (k: string): number => {
        const v = b[k];
        const n = typeof v === "number" ? v : Number(v);
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
      };
      const handle = await principalHandle(p, repo, auth);
      const usage = await repo.recordSkillUsage({
        userId: p.userId,
        userLabel: handle ? `@${handle}` : await principalEmail(p, repo, auth),
        project: normalizeProjectKey(typeof b.project === "string" ? b.project : ""),
        scope,
        critical: count("critical"),
        major: count("major"),
        minor: count("minor"),
        info: count("info"),
      });
      return ok({ id: usage.id }, 201);
    },
  },
  // GET aggregates per user. Admins see ALL users; everyone else sees only their
  // own (the user filter is forced server-side, never trusting the client).
  {
    method: "GET",
    pattern: /^\/api\/usage\/skill$/,
    handler: async ({ principal, query }, repo) => {
      const p = requirePrincipal(principal);
      const raw = query.get("bucket");
      const bucket: Bucket = raw === "week" || raw === "month" ? raw : "day";
      const admin = p.role === "admin";
      const events = await repo.listSkillUsage({
        since: defaultSince(bucket),
        ...(admin ? {} : { userId: p.userId }),
      });
      return ok({ bucket, scope: admin ? "all" : "self", rows: aggregateSkillByUser(events) });
    },
  },
  // --- Community review rulesets (self-service; ownership enforced per-handler) ---
  {
    method: "GET",
    pattern: /^\/api\/rulesets$/,
    handler: async ({ principal, query }, repo) => {
      const p = requirePrincipal(principal);
      if (query.get("scope") === "public") return ok(await repo.listPublicRulesets());
      return ok(await repo.listRulesetsByOwner(p.userId));
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/rulesets$/,
    handler: async ({ principal, body, auth }, repo) => {
      const p = requirePrincipal(principal);
      const b = (body ?? {}) as Record<string, unknown>;
      const name = asString(b.name, "name");
      const project = normalizeProjectKey(typeof b.project === "string" ? b.project : "");
      const ruleset = await repo.createRuleset({
        ownerId: p.userId,
        ownerEmail: await principalEmail(p, repo, auth),
        ownerHandle: await principalHandle(p, repo, auth),
        project,
        projectLabel: typeof b.projectLabel === "string" ? b.projectLabel : project,
        name,
        slug: slugify(name),
        description: typeof b.description === "string" ? b.description : "",
        visibility: asVisibility(b.visibility),
        language: typeof b.language === "string" ? b.language : "",
        focus: typeof b.focus === "string" ? b.focus : "",
        instructions: typeof b.instructions === "string" ? b.instructions : "",
        rules: parseRules(b.rules),
      });
      return ok(ruleset, 201);
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/rulesets\/(?<id>[^/]+)\/fork$/,
    handler: async ({ principal, params, auth }, repo) => {
      const p = requirePrincipal(principal);
      const src = await repo.getRuleset(params.id!);
      if (!src || (src.visibility !== "public" && src.ownerId !== p.userId)) {
        throw new HttpError(404, "ruleset not found");
      }
      const copy = await repo.createRuleset({
        ownerId: p.userId,
        ownerEmail: await principalEmail(p, repo, auth),
        ownerHandle: await principalHandle(p, repo, auth),
        // A fork is a manual adoption — not the auto-grown per-project ruleset, so
        // it claims no project slot (keeps the (owner, project) invariant intact).
        project: "",
        projectLabel: "",
        name: `${src.name} (fork)`,
        slug: slugify(`${src.name}-fork`),
        description: src.description,
        visibility: "private",
        language: src.language,
        focus: src.focus,
        instructions: src.instructions,
        // Forked candidates arrive already-promoted (no pending state carried over).
        rules: src.rules.map((r) => ({ ...r, pending: false })),
      });
      return ok(copy, 201);
    },
  },
  {
    // Auto-grow: the local skill submits extracted key points as candidate rules
    // into the caller's OWN per-project ruleset (upsert by (owner, project)).
    // PAT/session-authenticated. Candidates now take effect immediately (opt-out):
    // the owner can disable any rule later rather than having to promote each one.
    method: "POST",
    pattern: /^\/api\/rulesets\/candidates$/,
    handler: async ({ principal, body, auth }, repo) => {
      const p = requirePrincipal(principal);
      const b = (body ?? {}) as Record<string, unknown>;
      const project = normalizeProjectKey(asString(b.project, "project"));
      const projectLabel = typeof b.projectLabel === "string" && b.projectLabel ? b.projectLabel : project;
      const candidates = parseRules(b.rules); // in effect by default (opt-out)
      if (!candidates.length) throw new HttpError(400, "field 'rules' must contain at least one rule");

      const existing = await repo.findRulesetByOwnerAndProject(p.userId, project);
      if (existing) {
        // Append, de-duplicating by (title, instruction) against current rules.
        const seen = new Set(existing.rules.map((r) => `${r.title}\0${r.instruction}`));
        const fresh = candidates.filter((r) => !seen.has(`${r.title}\0${r.instruction}`));
        const updated = await repo.updateRuleset(existing.id, p.userId, {
          rules: [...existing.rules, ...fresh],
        });
        return ok({ ruleset: updated, added: fresh.length, skipped: candidates.length - fresh.length }, 200);
      }
      const name = typeof b.name === "string" && b.name ? b.name : projectLabel || "我的项目规则";
      const created = await repo.createRuleset({
        ownerId: p.userId,
        ownerEmail: await principalEmail(p, repo, auth),
        ownerHandle: await principalHandle(p, repo, auth),
        project,
        projectLabel,
        name,
        slug: slugify(name),
        description: typeof b.description === "string" ? b.description : "",
        visibility: "private",
        language: typeof b.language === "string" ? b.language : "",
        focus: typeof b.focus === "string" ? b.focus : "",
        instructions: "",
        rules: candidates,
      });
      return ok({ ruleset: created, added: candidates.length, skipped: 0 }, 201);
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/rulesets\/(?<id>[^/]+)$/,
    handler: async ({ principal, params }, repo) => {
      const p = requirePrincipal(principal);
      const r = await repo.getRuleset(params.id!);
      if (!r || (r.visibility !== "public" && r.ownerId !== p.userId)) {
        throw new HttpError(404, "ruleset not found");
      }
      return ok(r);
    },
  },
  {
    method: "PUT",
    pattern: /^\/api\/rulesets\/(?<id>[^/]+)$/,
    handler: async ({ principal, params, body }, repo) => {
      const p = requirePrincipal(principal);
      const b = (body ?? {}) as Record<string, unknown>;
      const patch: UpdateRulesetPatch = {};
      if (typeof b.name === "string") patch.name = b.name;
      if (typeof b.description === "string") patch.description = b.description;
      if (b.visibility !== undefined) patch.visibility = asVisibility(b.visibility);
      if (typeof b.language === "string") patch.language = b.language;
      if (typeof b.focus === "string") patch.focus = b.focus;
      if (typeof b.instructions === "string") patch.instructions = b.instructions;
      if (typeof b.projectLabel === "string") patch.projectLabel = b.projectLabel;
      if (Array.isArray(b.rules)) patch.rules = parseRules(b.rules);
      // updateRuleset is owner-scoped → EntityNotFoundError (404) for non-owners.
      return ok(await repo.updateRuleset(params.id!, p.userId, patch));
    },
  },
  {
    method: "DELETE",
    pattern: /^\/api\/rulesets\/(?<id>[^/]+)$/,
    handler: async ({ principal, params }, repo) => {
      const p = requirePrincipal(principal);
      await repo.deleteRuleset(params.id!, p.userId);
      return ok({ ok: true });
    },
  },
  {
    // Public discovery: a user's public rulesets by handle. No auth — this is
    // how the local orchestrator skill fetches "let X review my changes".
    method: "GET",
    pattern: /^\/api\/u\/(?<handle>[^/]+)\/rulesets$/,
    handler: async ({ params, query }, repo) => {
      const handle = slugify(params.handle!);
      const all = await repo.listPublicRulesets();
      // Optional project filter: a project-scoped ruleset matches its own key;
      // an "any project" ruleset (project === "") always matches.
      const projectFilter = normalizeProjectKey(query.get("project") ?? "");
      const rulesets = all
        .filter((r) => r.ownerHandle === handle)
        .filter((r) => !projectFilter || r.project === "" || r.project === projectFilter)
        // Strip PII: this endpoint is unauthenticated, so never leak the owner's
        // email or internal id. `handle` is the intended public identifier.
        // Only rules IN EFFECT are exposed — never legacy pending candidates nor
        // rules the owner has disabled.
        .map(({ ownerId: _ownerId, ownerEmail: _ownerEmail, ...pub }) => ({
          ...pub,
          rules: pub.rules.filter((rule) => !rule.pending && !rule.disabled),
        }));
      return ok({
        handle,
        ...(projectFilter ? { project: projectFilter } : {}),
        owner: { handle },
        rulesets,
      });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/health$/,
    handler: async () => ok({ status: "ok", service: "reviewpilot" }),
  },
  {
    method: "GET",
    pattern: /^\/api\/projects$/,
    handler: async (_ctx, repo) => ok(await repo.listProjects()),
  },
  {
    method: "POST",
    pattern: /^\/api\/projects$/,
    handler: async ({ body }, repo) => {
      const b = (body ?? {}) as Record<string, unknown>;
      const enabled = Array.isArray(b.enabledEngines) ? b.enabledEngines : [];
      const project = await repo.createProject({
        name: asString(b.name, "name"),
        platform: asEnum(b.platform, PLATFORMS, "platform"),
        defaultEngine: asEnum(b.defaultEngine, ENGINES, "defaultEngine"),
        enabledEngines: enabled.map((e, i) => asEnum(e, ENGINES, `enabledEngines[${i}]`)),
      });
      return ok(project, 201);
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/projects\/(?<id>[^/]+)$/,
    handler: async ({ params }, repo) => {
      const project = await repo.getProject(params.id!);
      if (!project) throw new HttpError(404, `project not found: ${params.id}`);
      const repos = await repo.listReposByProject(project.id);
      return ok({ ...project, repos });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/projects\/(?<id>[^/]+)\/repos$/,
    handler: async ({ params }, repo) => {
      if (!(await repo.getProject(params.id!))) {
        throw new HttpError(404, `project not found: ${params.id}`);
      }
      return ok(await repo.listReposByProject(params.id!));
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/projects\/(?<id>[^/]+)\/repos$/,
    handler: async ({ params, body }, repo) => {
      const b = (body ?? {}) as Record<string, unknown>;
      const platform = asEnum(b.platform, PLATFORMS, "platform");
      const fullName = asString(b.fullName, "fullName");
      // Idempotent: a repo is uniquely identified within a project by
      // (platform, fullName). If it's already registered, return the existing
      // record (200) instead of creating a duplicate — guards against
      // double-submits and retries.
      const existing = (await repo.listReposByProject(params.id!)).find(
        (r) => r.platform === platform && r.fullName === fullName,
      );
      if (existing) return ok(existing, 200);
      const created = await repo.createRepo({
        projectId: params.id!,
        platform,
        fullName,
        remoteUrl: asString(b.remoteUrl, "remoteUrl"),
        cloneUrl: asString(b.cloneUrl, "cloneUrl"),
        defaultBranch: asString(b.defaultBranch, "defaultBranch"),
      });
      return ok(created, 201);
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/jobs$/,
    handler: async ({ query }, repo) => {
      const status = query.get("status") ?? undefined;
      const pullRequestId = query.get("pullRequestId") ?? undefined;
      const jobs = await repo.listReviewJobs({
        ...(status ? { status: status as never } : {}),
        ...(pullRequestId ? { pullRequestId } : {}),
      });
      return ok(jobs);
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/jobs\/(?<id>[^/]+)$/,
    handler: async ({ params }, repo) => {
      const job = await repo.getReviewJob(params.id!);
      if (!job) throw new HttpError(404, `job not found: ${params.id}`);
      const pullRequest = await repo.getPullRequest(job.pullRequestId);
      const findings = await repo.listFindings(job.id);
      return ok({ ...job, pullRequest, findings });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/jobs\/(?<id>[^/]+)\/findings$/,
    handler: async ({ params }, repo) => {
      if (!(await repo.getReviewJob(params.id!))) {
        throw new HttpError(404, `job not found: ${params.id}`);
      }
      return ok(await repo.listFindings(params.id!));
    },
  },
  {
    // Requeue a failed job; the background worker drain re-runs it.
    method: "POST",
    pattern: /^\/api\/jobs\/(?<id>[^/]+)\/retry$/,
    handler: async ({ params }, repo) => {
      const job = await repo.getReviewJob(params.id!);
      if (!job) throw new HttpError(404, `job not found: ${params.id}`);
      if (job.status !== "failed") {
        throw new HttpError(409, `only failed jobs can be retried (job is ${job.status})`);
      }
      return ok(await repo.transitionReviewJob(job.id, "pending"));
    },
  },
  {
    // Self-contained review task — the single ingress for reviews. Callers
    // (GitHub Actions, other services, the Web UI form) POST everything needed;
    // no monitored project/repo has to be pre-registered.
    method: "POST",
    pattern: /^\/api\/tasks$/,
    handler: async ({ body }, _repo, tasks) => {
      if (!tasks) throw new HttpError(503, "task service not available");
      const b = (body ?? {}) as Record<string, unknown>;
      const platform = asEnum(b.platform, PLATFORMS, "platform");
      const repoFullName = asString(b.repoFullName, "repoFullName");

      // PR mode (prNumber) vs branch-diff mode (headBranch + baseBranch).
      const hasPr = b.prNumber !== undefined && b.prNumber !== null && b.prNumber !== "";
      const task: ReviewTaskInput = { platform, repoFullName };
      if (hasPr) {
        const prNumber =
          typeof b.prNumber === "number" ? b.prNumber : Number.parseInt(String(b.prNumber), 10);
        if (!Number.isFinite(prNumber) || prNumber <= 0) {
          throw new HttpError(400, "field 'prNumber' must be a positive integer");
        }
        task.prNumber = prNumber;
      } else if (b.headBranch || b.baseBranch) {
        task.headBranch = asString(b.headBranch, "headBranch");
        task.baseBranch = asString(b.baseBranch, "baseBranch");
        if (b.callback) task.callback = parseCallback(b.callback);
      } else {
        throw new HttpError(400, "provide 'prNumber' (PR mode) or 'headBranch'+'baseBranch' (branch mode)");
      }
      if (typeof b.cloneUrl === "string" && b.cloneUrl) task.cloneUrl = b.cloneUrl;
      if (b.engine) task.engine = asEnum(b.engine, ENGINES, "engine");

      const outcome = await tasks.createTask(task);
      if (outcome.status === "ignored") throw new HttpError(400, outcome.reason);
      if (outcome.status === "accepted") {
        return ok({ taskId: outcome.taskId, status: outcome.status }, 202);
      }
      return ok({ taskId: outcome.jobId, jobId: outcome.jobId, status: outcome.status }, 202);
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/schedules$/,
    handler: async (_ctx, _repo, _tasks, schedules) => {
      if (!schedules) throw new HttpError(503, "schedule store not available");
      // Drop the heavy per-run findings blob from the list; GET /:id returns it.
      const list = await schedules.list();
      return ok(list.map(({ lastScan: _omit, ...rest }) => rest));
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/schedules$/,
    handler: async ({ body }, _repo, _tasks, schedules, scheduler) => {
      if (!schedules) throw new HttpError(503, "schedule store not available");
      const created = await schedules.create(parseScheduleCreate(body));
      await scheduler?.refresh();
      return ok(created, 201);
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/schedules\/(?<id>[^/]+)$/,
    handler: async ({ params }, _repo, _tasks, schedules) => {
      if (!schedules) throw new HttpError(503, "schedule store not available");
      const s = await schedules.get(params.id!);
      if (!s) throw new HttpError(404, `schedule not found: ${params.id}`);
      return ok(s);
    },
  },
  {
    method: "PUT",
    pattern: /^\/api\/schedules\/(?<id>[^/]+)$/,
    handler: async ({ params, body }, _repo, _tasks, schedules, scheduler) => {
      if (!schedules) throw new HttpError(503, "schedule store not available");
      const updated = await schedules.update(params.id!, parseScheduleUpdate(body));
      await scheduler?.refresh();
      return ok(updated);
    },
  },
  {
    method: "DELETE",
    pattern: /^\/api\/schedules\/(?<id>[^/]+)$/,
    handler: async ({ params }, _repo, _tasks, schedules, scheduler) => {
      if (!schedules) throw new HttpError(503, "schedule store not available");
      await schedules.remove(params.id!);
      await scheduler?.refresh();
      return { status: 204, body: null };
    },
  },
  {
    // Run a schedule immediately (testing / on-demand), regardless of its time.
    method: "POST",
    pattern: /^\/api\/schedules\/(?<id>[^/]+)\/run$/,
    handler: async ({ params }, _repo, _tasks, schedules, scheduler) => {
      if (!schedules || !scheduler) throw new HttpError(503, "scheduler not available");
      const config = await schedules.get(params.id!);
      if (!config) throw new HttpError(404, `schedule not found: ${params.id}`);
      if (scheduler.isRunning(config.id) || config.running) {
        throw new HttpError(409, "schedule is already running");
      }
      const result = await scheduler.runConfig(config);
      return ok({ ran: result !== null, result });
    },
  },
];

/**
 * Validate a Feishu delivery spec: { type:"feishu", webhookUrl? }. webhookUrl
 * is optional — when omitted, delivery falls back to the deploy-wide
 * FEISHU_WEBHOOK_URL default at send time.
 */
function parseDelivery(v: unknown): DeliveryConfig {
  const d = (v ?? {}) as Record<string, unknown>;
  const type = asEnum(d.type, ["feishu"] as const, "delivery.type");
  const webhookUrl = typeof d.webhookUrl === "string" ? d.webhookUrl : "";
  return { type, webhookUrl };
}

function asBranches(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new HttpError(400, "field 'branches' must be an array of strings");
  return v.map((b, i) => asString(b, `branches[${i}]`));
}

function assertTime(v: string): string {
  if (parseTimeOfDay(v) === null) {
    throw new HttpError(400, "field 'timeOfDay' must be 'HH:MM' (24h)");
  }
  return v;
}

function asLookbackHours(v: unknown): number {
  const n = typeof v === "number" ? v : Number.parseInt(String(v), 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new HttpError(400, "field 'lookbackHours' must be a positive number");
  }
  return n;
}

function parseScheduleCreate(body: unknown): CreateScheduleInput {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    name: asString(b.name, "name"),
    platform: asEnum(b.platform, PLATFORMS, "platform"),
    repoFullName: asString(b.repoFullName, "repoFullName"),
    ...(typeof b.cloneUrl === "string" && b.cloneUrl ? { cloneUrl: b.cloneUrl } : {}),
    branches: asBranches(b.branches),
    timeOfDay: assertTime(asString(b.timeOfDay, "timeOfDay")),
    ...(typeof b.timezone === "string" && b.timezone ? { timezone: b.timezone } : {}),
    ...(b.lookbackHours !== undefined ? { lookbackHours: asLookbackHours(b.lookbackHours) } : {}),
    ...(typeof b.reviewFocus === "string" && b.reviewFocus ? { reviewFocus: b.reviewFocus } : {}),
    ...(b.engine ? { engine: asEnum(b.engine, ENGINES, "engine") } : {}),
    delivery: parseDelivery(b.delivery),
    ...(typeof b.enabled === "boolean" ? { enabled: b.enabled } : {}),
  };
}

function parseScheduleUpdate(body: unknown): UpdateScheduleInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const patch: UpdateScheduleInput = {};
  if (b.name !== undefined) patch.name = asString(b.name, "name");
  if (b.repoFullName !== undefined) patch.repoFullName = asString(b.repoFullName, "repoFullName");
  if (b.cloneUrl !== undefined) patch.cloneUrl = asString(b.cloneUrl, "cloneUrl");
  if (b.branches !== undefined) patch.branches = asBranches(b.branches);
  if (b.timeOfDay !== undefined) patch.timeOfDay = assertTime(asString(b.timeOfDay, "timeOfDay"));
  if (b.timezone !== undefined) patch.timezone = asString(b.timezone, "timezone");
  if (b.lookbackHours !== undefined) patch.lookbackHours = asLookbackHours(b.lookbackHours);
  if (b.reviewFocus !== undefined) {
    if (typeof b.reviewFocus !== "string") throw new HttpError(400, "field 'reviewFocus' must be a string");
    patch.reviewFocus = b.reviewFocus; // "" clears the focus
  }
  if (b.engine !== undefined) patch.engine = b.engine === null ? null : asEnum(b.engine, ENGINES, "engine");
  if (b.delivery !== undefined) patch.delivery = parseDelivery(b.delivery);
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean") throw new HttpError(400, "field 'enabled' must be a boolean");
    patch.enabled = b.enabled;
  }
  return patch;
}

/** Max accepted request body — guards against unbounded in-memory buffering (DoS). */
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on("data", (c: Buffer) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        reject(new HttpError(413, "request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!aborted) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (e) => {
      if (!aborted) reject(e);
    });
  });
}

/**
 * REST API for the Jenkins-like Web UI. Read paths expose projects, repos,
 * jobs (with progress/logs) and findings; write paths configure projects and
 * repos. Platform credentials remain env-configured (see config layer), not
 * stored per-project, so nothing secret is returned here.
 */
export interface ApiOptions {
  /**
   * Session-token signing secret. When set, the API enforces auth (per-route
   * role via RBAC); when empty, auth is OFF (open) — used by unit tests.
   */
  sessionSecret?: string;
  /** Session token lifetime in ms (default 7 days). */
  sessionTtlMs?: number;
  /** Built-in admin email (env-configured; not in the DB). */
  adminEmail?: string;
  /** Config-only PAT for the env admin (bearer auth without a DB row); enables it. */
  adminToken?: string;
  /** When true, roles are IdP-managed → the role-change route is disabled. */
  rolesManagedExternally?: boolean;
  /** Required for the POST /api/tasks route. */
  taskService?: TaskService;
  /** Required for the /api/schedules routes. */
  scheduleStore?: ScheduleStore;
  /** Refreshed after schedule mutations; drives manual run-now. */
  scheduler?: Scheduler;
  /**
   * Review-attestation signing config. Built into a signer once at startup; when
   * `signingKey` is empty the attestation endpoints answer 503. A malformed key
   * throws here (fail fast).
   */
  attest?: {
    signingKey: string;
    keyId: string;
    enforce: AttestEnforce;
    blockSeverity: Severity;
    ttlMs: number;
  };
  /** Runtime attestation policy store (Web-UI managed enforcement policy). */
  attestPolicy?: AttestPolicyStore;
}

export function createApiHandler(repo: Repository, options: ApiOptions = {}) {
  const secret = options.sessionSecret ?? "";
  const auth: AuthConfig = {
    secret,
    sessionTtlMs: options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
    envAdmin: envAdminFrom(options.adminEmail ?? "", options.adminToken ?? ""),
    rolesManagedExternally: options.rolesManagedExternally ?? false,
  };
  const tasks = options.taskService;
  const schedules = options.scheduleStore;
  const scheduler = options.scheduler;
  // Build the attestation signer once (throws on a malformed key → fail fast).
  const attest: AttestSigner | null = options.attest ? buildAttestSigner(options.attest) : null;
  const attestPolicy: AttestPolicyStore | null = options.attestPolicy ?? null;
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? "GET";
    const parsed = new URL(req.url ?? "/", "http://localhost");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    // Resolve the caller (session JWT or PAT). No header → null (fast path).
    const principal = await resolvePrincipal(req.headers.authorization, repo, secret, auth.envAdmin);
    // Enforce RBAC only when a signing secret is configured (auth enabled).
    if (secret) {
      const need = requiredRole(method, parsed.pathname);
      if (need !== "public") {
        if (!principal) {
          send(401, { error: "unauthorized" });
          return;
        }
        if (!roleAtLeast(principal.role, need)) {
          send(403, { error: `forbidden: requires '${need}'` });
          return;
        }
      }
    }
    const route = ROUTES.find(
      (r) => r.method === method && r.pattern.test(parsed.pathname),
    );
    if (!route) {
      send(404, { error: `no route for ${method} ${parsed.pathname}` });
      return;
    }
    try {
      const match = route.pattern.exec(parsed.pathname);
      const params = match?.groups ?? {};
      let body: unknown;
      if (method === "POST" || method === "PUT" || method === "PATCH") {
        const raw = await readBody(req);
        body = raw ? JSON.parse(raw) : {};
      }
      const result = await route.handler(
        { params, body, query: parsed.searchParams, principal, auth, attest, attestPolicy },
        repo,
        tasks,
        schedules,
        scheduler,
      );
      send(result.status, result.body);
    } catch (err) {
      if (err instanceof HttpError) send(err.status, { error: err.message });
      else if (err instanceof EntityNotFoundError) send(404, { error: err.message });
      else if (err instanceof ScheduleNotFoundError) send(404, { error: err.message });
      else if (err instanceof SyntaxError) send(400, { error: "invalid JSON body" });
      else send(500, { error: (err as Error).message });
    }
  };
}

/** Start an HTTP server exposing the REST API. */
export function startApiServer(repo: Repository, port: number): Server {
  const handler = createApiHandler(repo);
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  server.listen(port);
  return server;
}
