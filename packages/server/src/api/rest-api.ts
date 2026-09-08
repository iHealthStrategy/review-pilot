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
import {
  type Bucket,
  aggregateSkillByProject,
  aggregateSkillByUser,
  aggregateUsage,
  bucketForRange,
  defaultSince,
  isRange,
  sinceForRange,
  type Range,
} from "../usage/aggregate.js";
import { SKILL_FINDING_LIMITS } from "../domain/entities.js";
import type { SkillFinding } from "../domain/entities.js";
import { normalizeProjectKey, slugify } from "../skill/review-skill.js";
import type { ReviewRule, ReviewRuleset, RulesetVisibility } from "../domain/entities.js";
import { RULE_LOAD_POLICY } from "../domain/entities.js";
import { applyRuleHits, rankLayered, rankRules, type RuleLayer } from "../review/rule-ranking.js";
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

/**
 * A non-negative millisecond duration, or undefined when absent/unusable.
 * Reported by a client we don't control, so anything non-finite or negative is
 * dropped rather than stored as a bogus stat.
 */
function optionalMs(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n);
}

/** `{ [key]: n }` for a usable non-negative count, or `{}` when absent/bogus. */
function optionalCount(v: unknown, key: string): Record<string, number> {
  const n = optionalMs(v); // same coercion: finite, non-negative, integral
  return n === undefined ? {} : { [key]: n };
}

/**
 * Applied fixes, never exceeding the proposed count. Reported by a client we do
 * not control, and an adoption rate above 100% would be nonsense in every view
 * that reads it.
 */
function clampedApplied(proposed: unknown, applied: unknown): Record<string, number> {
  const a = optionalMs(applied);
  if (a === undefined) return {};
  const p = optionalMs(proposed);
  return { fixesApplied: p === undefined ? a : Math.min(a, p) };
}

/**
 * Coerce a reported findings array into stored {@link SkillFinding}s, applying
 * {@link SKILL_FINDING_LIMITS}. Findings come from a local skill run, so the
 * server bounds both the array and each string: an unbounded payload would
 * otherwise land straight in the database. Entries without a usable severity
 * and title are dropped, and we truncate rather than reject so one malformed
 * finding never loses the whole run's stats.
 */
function sanitizeFindings(v: unknown): SkillFinding[] {
  if (!Array.isArray(v)) return [];
  const L = SKILL_FINDING_LIMITS;
  const clip = (s: unknown, max: number): string =>
    typeof s === "string" ? s.trim().slice(0, max) : "";
  const out: SkillFinding[] = [];
  for (const raw of v.slice(0, L.maxFindings)) {
    if (!raw || typeof raw !== "object") continue;
    const f = raw as Record<string, unknown>;
    const severity = SEVERITIES.find((s) => s === f.severity);
    const title = clip(f.title, L.maxTitle);
    if (!severity || !title) continue;
    const line = typeof f.line === "number" && Number.isFinite(f.line) && f.line > 0
      ? Math.floor(f.line)
      : undefined;
    const detail = clip(f.detail, L.maxDetail);
    const suggestion = clip(f.suggestion, L.maxSuggestion);
    const category = clip(f.category, L.maxCategory);
    out.push({
      severity,
      filePath: clip(f.filePath, L.maxPath),
      title,
      ...(line === undefined ? {} : { line }),
      ...(detail ? { detail } : {}),
      ...(suggestion ? { suggestion } : {}),
      ...(category ? { category } : {}),
    });
  }
  return out;
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
const SEVERITIES: readonly Severity[] = ["critical", "major", "minor", "info"];
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

/**
 * Admin-only guard for handlers whose response spans other users' data. The
 * route table in {@link requiredRole} already gates these paths; this is the
 * second lock, so a future routing change can't silently open one up.
 */
function requireAdmin(principal: Principal | null): Principal {
  const p = requirePrincipal(principal);
  if (!roleAtLeast(p.role, "admin")) throw new HttpError(403, "admin only");
  return p;
}

/**
 * Human display names by user id, for usage tables.
 *
 * Usage rows store a `userLabel` captured when the run was reported, which is
 * `@handle` — and an OIDC-provisioned handle is often a 64-char opaque subject,
 * unreadable in a table. The identity provider's `name` claim is what a person
 * actually recognises, so resolve it live: it also picks up renames that the
 * stored label predates.
 */
async function displayNames(repo: Repository): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const u of await repo.listUsers()) {
    const real = u.email && !u.email.endsWith("@users.noreply.local") ? u.email : "";
    const name = u.name || real || (u.handle ? `@${u.handle}` : "");
    if (name) names.set(u.id, name);
  }
  return names;
}

/**
 * Resolve however a person referred to a reviewer into that reviewer's canonical
 * handle.
 *
 * A handle is generated from `preferred_username || email || sub`, so an IdP
 * account with neither ends up with its 64-char subject as a handle — unusable
 * in "让 X 帮我 review". People know each other by the display name the identity
 * provider shows, so accept that too: handle, display name, email local part,
 * or a slugified display name, matched case-insensitively.
 *
 * Returns "" when nothing matches, and also when a display name is AMBIGUOUS —
 * silently picking one of two people called the same thing would apply the
 * wrong person's rules, which is worse than saying "I couldn't find them".
 *
 * `eligible` narrows the candidate set; the unauthenticated route passes the
 * owners of public rulesets so name lookup can't be used to enumerate users.
 */
async function resolveReviewerHandle(
  repo: Repository,
  typed: string,
  eligible?: ReadonlySet<string>,
): Promise<{ handle: string; name: string; ambiguous: boolean }> {
  const want = typed.trim().toLowerCase();
  const miss = { handle: "", name: "", ambiguous: false };
  if (!want) return miss;
  const all = await repo.listUsers();
  const users = eligible ? all.filter((u) => eligible.has(u.handle)) : all;
  const found = (u: User) => ({ handle: u.handle, name: u.name || "", ambiguous: false });

  // A handle is unique, so an exact hit always wins — including for someone who
  // deliberately typed the opaque id.
  const byHandle = users.find((u) => u.handle.toLowerCase() === want);
  if (byHandle) return found(byHandle);

  const localPart = (email: string) =>
    email && !email.endsWith("@users.noreply.local") ? (email.split("@")[0] ?? "").toLowerCase() : "";
  for (const match of [
    (u: User) => (u.name || "").trim().toLowerCase() === want,
    (u: User) => localPart(u.email) === want,
    // "Zhang Wei" typed as "zhang-wei", and vice versa.
    (u: User) => !!u.name && slugify(u.name) === slugify(typed),
  ]) {
    const hits = users.filter(match);
    if (hits.length === 1) return found(hits[0]!);
    if (hits.length > 1) return { handle: "", name: "", ambiguous: true };
  }
  return miss;
}

/**
 * Per-user rule contribution: how many rules a person has grown that are in
 * effect, and how many of those have actually caught something.
 *
 * This is the "did you turn a one-off finding into durable team knowledge"
 * signal — closer to real value than a findings count, which only rewards
 * volume. Derived from ruleset ownership, so it needs no extra storage.
 */
async function ruleContribution(
  repo: Repository,
  userIds: readonly string[],
): Promise<Map<string, { rulesOwned: number; rulesHit: number }>> {
  const byOwner = new Map<string, { rulesOwned: number; rulesHit: number }>();
  // One lookup per user rather than a new "list every ruleset" repository
  // method: the contract stays strictly owner-scoped, and this runs over the
  // handful of users that appear in a usage window, not the whole table.
  for (const userId of userIds) {
    const acc = { rulesOwned: 0, rulesHit: 0 };
    for (const rs of await repo.listRulesetsByOwner(userId)) {
      // The project-level ruleset is curated, not grown: crediting it to the
      // admin who happens to own the row would count other people's promoted
      // rules as that admin's contribution.
      if (rs.kind === "project") continue;
      for (const rule of rs.rules) {
        if (rule.pending || rule.disabled) continue; // not in effect → not a contribution
        acc.rulesOwned += 1;
        if (typeof rule.hits === "number" && rule.hits > 0) acc.rulesHit += 1;
      }
    }
    byOwner.set(userId, acc);
  }
  return byOwner;
}

/** Attach `userName` to rows that carry a `userId`, leaving them otherwise intact. */
function withUserNames<T extends { userId: string }>(
  rows: readonly T[],
  names: Map<string, string>,
): (T & { userName?: string })[] {
  return rows.map((r) => {
    const name = names.get(r.userId);
    return name ? { ...r, userName: name } : { ...r };
  });
}

/** `?bucket=` with a safe default, shared by the usage endpoints. */
function asBucket(raw: string | null): Bucket {
  return raw === "week" || raw === "month" ? raw : "day";
}

/**
 * The time window a usage query covers, from `?range=` (7d/30d/90d/365d).
 *
 * Falls back to the legacy `?bucket=` window so an older client keeps working;
 * `bucket` is also returned so the token view still knows what granularity to
 * group by, derived from the range rather than chosen separately.
 */
function resolveWindow(query: URLSearchParams): { range: Range | null; bucket: Bucket; since: string } {
  const raw = query.get("range");
  if (isRange(raw)) {
    return { range: raw, bucket: bucketForRange(raw), since: sinceForRange(raw) };
  }
  const bucket = asBucket(query.get("bucket"));
  return { range: null, bucket, since: defaultSince(bucket) };
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

/**
 * The owner id a ruleset write must be scoped to: the caller for their own
 * rulesets, and the ruleset's REAL owner when an admin moderates someone
 * else's. Keeping the resolution here means the repository contract stays
 * strictly owner-scoped — there is no privileged bypass below this layer.
 * An unknown id falls back to the caller so the repository still raises the
 * usual 404 rather than this layer inventing one.
 */
async function rulesetWriteOwner(p: Principal, id: string, repo: Repository): Promise<string> {
  if (!roleAtLeast(p.role, "admin")) return p.userId;
  const existing = await repo.getRuleset(id);
  return existing?.ownerId ?? p.userId;
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
/**
 * Validate an inbound `promotedFrom` blob, or undefined. Trusted only as far as
 * `hits` is: the UI resends it on every edit, so it has to survive the round
 * trip, and a forged provenance is a display-level lie, not an access grant.
 */
function asPromotion(v: unknown): ReviewRule["promotedFrom"] | undefined {
  if (!v || typeof v !== "object") return undefined;
  const r = v as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === "string" ? x.slice(0, 200) : "");
  const ownerId = str(r.ownerId);
  const rulesetId = str(r.rulesetId);
  if (!ownerId || !rulesetId) return undefined;
  const at = typeof r.at === "string" && Number.isFinite(Date.parse(r.at)) ? r.at : "";
  return {
    ownerId,
    rulesetId,
    title: str(r.title),
    at: at || new Date().toISOString(),
    ...(str(r.ownerName) ? { ownerName: str(r.ownerName) } : {}),
    ...(str(r.by) ? { by: str(r.by) } : {}),
  };
}

/**
 * Parse an inbound rules array.
 *
 * `createdAt`/`hits`/`lastHitAt` are PASSED THROUGH when the payload carries
 * them: a ruleset edit from the web UI resends the whole array, so dropping
 * them here would silently reset every rule's earned ranking on each save.
 * `stampCreatedAt` gives genuinely new rules (auto-grown candidates) their
 * creation time so the ranking can grant them a fair-chance slot.
 */
function parseRules(
  v: unknown,
  forcePending = false,
  stampCreatedAt?: string,
): ReviewRule[] {
  if (!Array.isArray(v)) return [];
  const asStrArray = (x: unknown): string[] =>
    Array.isArray(x) ? x.filter((s): s is string => typeof s === "string" && s.length > 0) : [];
  const asCount = (x: unknown): number | undefined => {
    const n = typeof x === "number" ? x : Number(x);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
  };
  const asIso = (x: unknown): string | undefined => {
    if (typeof x !== "string" || !x) return undefined;
    return Number.isFinite(Date.parse(x)) ? x : undefined;
  };
  const rules: ReviewRule[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const title = typeof r.title === "string" ? r.title.trim() : "";
    const instruction = typeof r.instruction === "string" ? r.instruction.trim() : "";
    if (!instruction) continue; // a rule with no instruction is meaningless
    const hits = asCount(r.hits);
    const lastHitAt = asIso(r.lastHitAt);
    const createdAt = asIso(r.createdAt) ?? stampCreatedAt;
    // Same reason as `hits`: editing a project-level ruleset resends the whole
    // array, and dropping this would erase who grew each promoted rule.
    const promotedFrom = asPromotion(r.promotedFrom);
    rules.push({
      title: title || "Rule",
      instruction,
      globs: asStrArray(r.globs),
      languages: asStrArray(r.languages),
      topics: asStrArray(r.topics),
      ...(forcePending || r.pending === true ? { pending: true } : {}),
      ...(r.disabled === true ? { disabled: true } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(hits === undefined ? {} : { hits }),
      ...(lastHitAt ? { lastHitAt } : {}),
      ...(promotedFrom ? { promotedFrom } : {}),
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
      const { range, bucket, since } = resolveWindow(query);
      const source = query.get("source");
      const events = await repo.listTokenUsage({
        since,
        ...(source === "schedule" || source === "task" ? { source } : {}),
      });
      return ok({ bucket, range, rows: aggregateUsage(events, bucket) });
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
      // Timings and findings are OPTIONAL: skills installed before review-stats
      // existed report counts only, and must keep working unchanged.
      const durationMs = optionalMs(b.durationMs);
      // Active time is meaningless without a total to subtract waits from, and
      // no view reads it alone — so the pair is all-or-nothing, matching what
      // the skill is told to send.
      const activeMs = durationMs === undefined ? undefined : optionalMs(b.activeMs);
      const usage = await repo.recordSkillUsage({
        userId: p.userId,
        userLabel: handle ? `@${handle}` : await principalEmail(p, repo, auth),
        project: normalizeProjectKey(typeof b.project === "string" ? b.project : ""),
        scope,
        critical: count("critical"),
        major: count("major"),
        minor: count("minor"),
        info: count("info"),
        ...(durationMs === undefined ? {} : { durationMs }),
        // Active time can never exceed wall clock; clamp rather than reject so a
        // sloppy client still yields usable stats.
        ...(activeMs === undefined || durationMs === undefined
          ? {}
          : { activeMs: Math.min(activeMs, durationMs) }),
        // Change size, fix-pass outcome and the change grouping key — all
        // optional, so skills predating them keep reporting successfully.
        ...optionalCount(b.filesChanged, "filesChanged"),
        ...optionalCount(b.linesChanged, "linesChanged"),
        ...optionalCount(b.fixesProposed, "fixesProposed"),
        // Applied can never exceed proposed; clamp rather than reject so one
        // sloppy client cannot produce an adoption rate above 100%.
        ...clampedApplied(b.fixesProposed, b.fixesApplied),
        ...(typeof b.changeKey === "string" && b.changeKey.trim()
          ? { changeKey: b.changeKey.trim().slice(0, 200) }
          : {}),
        findings: sanitizeFindings(b.findings),
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
      const { range, bucket, since } = resolveWindow(query);
      const admin = p.role === "admin";
      const events = await repo.listSkillUsage({
        since,
        ...(admin ? {} : { userId: p.userId }),
      });
      const aggregated = aggregateSkillByUser(events);
      const contribution = await ruleContribution(repo, aggregated.map((r) => r.userId));
      const rows = withUserNames(aggregated, await displayNames(repo)).map((r) => ({
        ...r,
        ...(contribution.get(r.userId) ?? { rulesOwned: 0, rulesHit: 0 }),
      }));
      return ok({ bucket, range, scope: admin ? "all" : "self", rows });
    },
  },
  // Per-project problem summary — what a project's reviews keep turning up.
  // ADMIN ONLY (also gated in requiredRole): it spans every user's reviews.
  {
    method: "GET",
    pattern: /^\/api\/usage\/skill\/projects$/,
    handler: async ({ principal, query }, repo) => {
      requireAdmin(principal);
      const { range, bucket, since } = resolveWindow(query);
      const events = await repo.listSkillUsage({
        since,
        ...(query.get("project") ? { project: query.get("project")! } : {}),
      });
      return ok({ bucket, range, rows: aggregateSkillByProject(events) });
    },
  },
  // Raw per-run detail, newest first, including each run's findings. ADMIN ONLY
  // (also gated in requiredRole) — this is the least-aggregated view there is.
  {
    method: "GET",
    pattern: /^\/api\/usage\/skill\/runs$/,
    handler: async ({ principal, query }, repo) => {
      requireAdmin(principal);
      const { range, bucket, since } = resolveWindow(query);
      const rawLimit = Number(query.get("limit"));
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 500) : 100;
      const runs = await repo.listSkillUsage({
        since,
        limit,
        ...(query.get("project") ? { project: query.get("project")! } : {}),
        ...(query.get("userId") ? { userId: query.get("userId")! } : {}),
      });
      return ok({ bucket, range, limit, runs: withUserNames(runs, await displayNames(repo)) });
    },
  },
  // --- Community review rulesets (self-service; ownership enforced per-handler) ---
  {
    method: "GET",
    pattern: /^\/api\/rulesets$/,
    handler: async ({ principal, query }, repo) => {
      const p = requirePrincipal(principal);
      if (query.get("scope") === "all") {
        // ADMIN overview: every person's rulesets, PRIVATE ones included, so an
        // admin can see which rules each user has grown. Gated in the handler
        // rather than in `requiredRole` — the path is shared with the
        // self-service listing above, which any authenticated user may call.
        requireAdmin(principal);
        const names = await displayNames(repo);
        return ok(
          // Personal rulesets only: the project-level ones are not "someone's
          // rules" and are managed through /api/project-rules.
          (await repo.listAllRulesets()).filter((r) => r.kind !== "project").map((r) => ({
            ...r,
            ownerName: names.get(r.ownerId) || r.ownerHandle || r.ownerEmail || "",
          })),
        );
      }
      if (query.get("scope") === "public") {
        // Carry the owner's display name so the UI can show "让 <名字> 帮我
        // review" — the handle may be an opaque 64-char subject nobody can type.
        const names = await displayNames(repo);
        const byHandle = new Map(
          (await repo.listUsers()).map((u) => [u.handle, names.get(u.id) ?? ""]),
        );
        return ok(
          (await repo.listPublicRulesets()).map((r) => ({
            ...r,
            ownerName: byHandle.get(r.ownerHandle) || r.ownerHandle,
          })),
        );
      }
      // The project-level ruleset is managed under /api/project-rules, not here:
      // it belongs to the project, and the admin who happens to own the row
      // should not be offered a 删除 button for what the whole team is held to.
      return ok((await repo.listRulesetsByOwner(p.userId)).filter((r) => r.kind !== "project"));
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
      // In effect by default (opt-out), and stamped so the ranking can give a
      // brand-new rule a reserved slot in the next few reviews.
      const candidates = parseRules(b.rules, false, new Date().toISOString());
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
    // The project-level MANDATORY rules. Readable by any authenticated user —
    // you are held to these, so you get to read them, and someone who has not
    // grown a single rule of their own is exactly who needs to read them first.
    // Promoting and demoting are admin-only (gated in `requiredRole` too).
    //
    // With `?project=`: that project's ruleset (or null). Without: every
    // project's, so a client can show them without first knowing which projects
    // exist (the project list is already viewer-readable via /api/projects).
    method: "GET",
    pattern: /^\/api\/project-rules$/,
    handler: async ({ principal, query }, repo) => {
      requirePrincipal(principal);
      const project = normalizeProjectKey(query.get("project") ?? "");
      if (!project) {
        const all = (await repo.listAllRulesets()).filter((r) => r.kind === "project");
        return ok({ rulesets: all });
      }
      return ok({ project, ruleset: await repo.findProjectRuleset(project) });
    },
  },
  {
    // Promote personal rules into the project's mandatory ruleset.
    //
    // A COPY is taken, not a reference: the project must keep applying the rule
    // even if its author edits, disables or deletes their own copy, and the
    // admin needs to be able to reword it for a team audience. `promotedFrom`
    // records who grew it, so promotion credits the author instead of quietly
    // absorbing their work. The copy's ranking starts fresh — it is a new rule
    // for everyone else on the project, so it gets a new-rule trial slot rather
    // than inheriting hits earned in one person's reviews.
    method: "POST",
    pattern: /^\/api\/project-rules\/promote$/,
    handler: async ({ principal, body, auth }, repo) => {
      const p = requireAdmin(principal);
      const b = (body ?? {}) as Record<string, unknown>;
      const source = await repo.getRuleset(asString(b.rulesetId, "rulesetId"));
      if (!source) throw new HttpError(404, "ruleset not found");
      const project = normalizeProjectKey(
        typeof b.project === "string" && b.project ? b.project : source.project,
      );
      // A mandatory rule has to be mandatory FOR something: an "any project"
      // source ruleset carries no project key, so the caller must name one.
      if (!project) throw new HttpError(400, "field 'project' is required for an 'any project' ruleset");
      const wanted = new Set(
        (Array.isArray(b.titles) ? b.titles : [])
          .filter((t): t is string => typeof t === "string")
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean),
      );
      if (!wanted.size) throw new HttpError(400, "field 'titles' must contain at least one rule title");
      // Only rules IN EFFECT can be promoted: making the project depend on a
      // rule its author has switched off would be a rule nobody is running.
      const picked = source.rules.filter(
        (r) => wanted.has(r.title.trim().toLowerCase()) && !r.pending && !r.disabled,
      );
      if (!picked.length) throw new HttpError(400, "none of those rules are in effect on that ruleset");

      const now = new Date().toISOString();
      const names = await displayNames(repo);
      const copies: ReviewRule[] = picked.map((r) => {
        const { hits: _hits, lastHitAt: _lastHitAt, pending: _p, disabled: _d, ...rule } = r;
        return {
          ...rule,
          createdAt: now,
          promotedFrom: {
            ownerId: source.ownerId,
            ...(names.get(source.ownerId) ? { ownerName: names.get(source.ownerId)! } : {}),
            rulesetId: source.id,
            title: r.title,
            at: now,
            by: p.userId,
          },
        };
      });

      const projectLabel =
        typeof b.projectLabel === "string" && b.projectLabel
          ? b.projectLabel
          : source.project === project
            ? source.projectLabel || project
            : project;
      const existing = await repo.findProjectRuleset(project);
      if (existing) {
        // De-duplicate on (title, instruction): re-promoting the same rule from
        // two people's rulesets should not double it in every review.
        const seen = new Set(existing.rules.map((r) => `${r.title}\0${r.instruction}`));
        const fresh = copies.filter((r) => !seen.has(`${r.title}\0${r.instruction}`));
        const updated = await repo.updateRuleset(existing.id, existing.ownerId, {
          rules: [...existing.rules, ...fresh],
        });
        return ok({ ruleset: updated, added: fresh.length, skipped: copies.length - fresh.length });
      }
      const name = `${projectLabel} 项目必选规则`;
      const created = await repo.createRuleset({
        ownerId: p.userId,
        ownerEmail: await principalEmail(p, repo, auth),
        ownerHandle: await principalHandle(p, repo, auth),
        project,
        projectLabel,
        name,
        slug: slugify(name),
        description: "管理员从个人规则中提升的项目级必选规则",
        // Never public: this is not a community ruleset to install or fork, and
        // reviews reach it through the project layer, not through discovery.
        visibility: "private",
        kind: "project",
        language: "",
        focus: "",
        instructions: "",
        rules: copies,
      });
      return ok({ ruleset: created, added: copies.length, skipped: 0 }, 201);
    },
  },
  {
    // Take rules back out of the project's mandatory ruleset. Titles, not ids,
    // because that is what the UI (and the rule-hit report) works in.
    method: "POST",
    pattern: /^\/api\/project-rules\/demote$/,
    handler: async ({ principal, body }, repo) => {
      requireAdmin(principal);
      const b = (body ?? {}) as Record<string, unknown>;
      const project = normalizeProjectKey(asString(b.project, "project"));
      const ruleset = await repo.findProjectRuleset(project);
      if (!ruleset) throw new HttpError(404, "no project-level ruleset for that project");
      const wanted = new Set(
        (Array.isArray(b.titles) ? b.titles : [])
          .filter((t): t is string => typeof t === "string")
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean),
      );
      if (!wanted.size) throw new HttpError(400, "field 'titles' must contain at least one rule title");
      const rules = ruleset.rules.filter((r) => !wanted.has(r.title.trim().toLowerCase()));
      const removed = ruleset.rules.length - rules.length;
      if (!removed) return ok({ ruleset, removed: 0 });
      const updated = await repo.updateRuleset(ruleset.id, ruleset.ownerId, { rules });
      return ok({ ruleset: updated, removed });
    },
  },
  {
    // A review reports which rules actually CAUGHT something, so the ranking can
    // float them up next time. Allowed for the owner and for any PUBLIC ruleset:
    // a shared ruleset only improves if the people using it feed hits back.
    //
    // Read-modify-write, like the candidates upsert above: two reviews reporting
    // hits on the same ruleset at the same instant can lose one increment. That
    // is acceptable for a ranking counter — it is a popularity signal, not a
    // ledger — and avoids a per-rule row for what is stored as a JSON blob.
    method: "POST",
    pattern: /^\/api\/rulesets\/(?<id>[^/]+)\/rule-hits$/,
    handler: async ({ principal, params, body }, repo) => {
      const p = requirePrincipal(principal);
      const b = (body ?? {}) as Record<string, unknown>;
      const titles = Array.isArray(b.titles)
        ? b.titles.filter((t): t is string => typeof t === "string")
        : [];
      const ruleset = await repo.getRuleset(params.id!);
      if (!ruleset) throw new HttpError(404, "ruleset not found");
      const mayReport =
        ruleset.ownerId === p.userId ||
        ruleset.visibility === "public" ||
        roleAtLeast(p.role, "admin");
      if (!mayReport) throw new HttpError(403, "cannot report hits on a private ruleset you do not own");
      if (!titles.length) return ok({ matched: 0, updated: false });
      const { rules, matched } = applyRuleHits(ruleset.rules, titles, new Date().toISOString());
      if (!matched.length) return ok({ matched: 0, updated: false });
      // Scope the write to the ruleset's REAL owner: the reporter is often not
      // the owner, and the repository contract stays strictly owner-scoped.
      await repo.updateRuleset(ruleset.id, ruleset.ownerId, { rules });
      return ok({ matched: matched.length, updated: true });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/rulesets\/(?<id>[^/]+)$/,
    handler: async ({ principal, params }, repo) => {
      const p = requirePrincipal(principal);
      const r = await repo.getRuleset(params.id!);
      // Any authenticated user may read a PUBLIC ruleset in full (read-only
      // detail view); private ones stay visible to their owner and to admins,
      // who may also edit them.
      const mayRead = r
        && (r.visibility === "public" || r.ownerId === p.userId || roleAtLeast(p.role, "admin"));
      if (!mayRead) throw new HttpError(404, "ruleset not found");
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
      // updateRuleset is owner-scoped → EntityNotFoundError (404) for non-owners;
      // an admin's write is scoped to the ruleset's own owner so it goes through.
      const ownerId = await rulesetWriteOwner(p, params.id!, repo);
      return ok(await repo.updateRuleset(params.id!, ownerId, patch));
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
    // The rules a review should actually apply, merged and ranked as ONE budget
    // split across three layers (project-level / own / other people's).
    //
    // The skill used to have only the unauthenticated public-discovery endpoint,
    // so a user's OWN auto-grown rules — created private by default — were never
    // loaded at all, and only applied if they manually published the ruleset and
    // named themselves as the reviewer. This endpoint authenticates, so it can
    // include them, and pools them with the rules of everyone else working on
    // the SAME project plus any named reviewer's public ones — with a floor per
    // layer, so no single person's ruleset can take the whole prompt.
    //
    // Each returned rule carries `rulesetId` so hits can be reported back to the
    // ruleset that owns it (rules from different rulesets can share a title).
    method: "GET",
    pattern: /^\/api\/review-rules$/,
    handler: async ({ principal, query }, repo) => {
      const p = requirePrincipal(principal);
      const project = normalizeProjectKey(query.get("project") ?? "");
      // A ruleset governs this review when it targets this project, or targets
      // "any project" ("").
      const governs = (r: ReviewRuleset): boolean =>
        !project || r.project === "" || r.project === project;

      // Own rulesets — including PRIVATE ones, which is the whole point. The
      // project-level ruleset is excluded here even when the caller happens to
      // own it: it is its own layer below, with its own reserved budget.
      const own = (await repo.listRulesetsByOwner(p.userId))
        .filter(governs)
        .filter((r) => r.kind !== "project");
      // The project's MANDATORY ruleset: an admin curates it by promoting
      // personal rules into it, and it applies to everyone reviewing the
      // project — the caller does not opt in and cannot opt out.
      const mandatory = project ? await repo.findProjectRuleset(project) : null;
      // TEAMMATES' rules for this same project, whatever their visibility.
      // Reviewing with a colleague's accumulated rules is the whole point of
      // pooling them: they hit the same pitfalls in the same code, and their
      // auto-grown ruleset is private by default, so nothing would be shared if
      // this waited for people to publish. Requires an explicit project key —
      // without one this would pull in every ruleset on the server.
      const teammates = project
        ? (await repo.listRulesetsForProject(project)).filter(
            (r) => r.ownerId !== p.userId && r.kind !== "project",
          )
        : [];
      // A named reviewer contributes only their PUBLIC rulesets, never private.
      // The caller may name them however they know them — display name, handle,
      // or email local part — so resolve to the canonical handle here rather
      // than making people memorise an opaque id.
      const rawReviewer = (query.get("reviewer") ?? "").trim();
      const resolved = rawReviewer
        ? await resolveReviewerHandle(repo, rawReviewer)
        : { handle: "", name: "", ambiguous: false };
      const reviewer = resolved.handle;
      const borrowedRaw = reviewer
        ? (await repo.listPublicRulesets()).filter(
            (r) =>
              r.ownerHandle === reviewer &&
              r.ownerId !== p.userId &&
              r.kind !== "project" &&
              governs(r),
          )
        : [];
      // A named reviewer working on this same project is already in `teammates`;
      // naming them adds their "any project" rulesets, not a second copy.
      const teammateIds = new Set(teammates.map((r) => r.id));
      const borrowed = borrowedRaw.filter((r) => !teammateIds.has(r.id));

      const rawLimit = query.get("limit");
      const parsedLimit = rawLimit === null || rawLimit === "" ? NaN : Number(rawLimit);
      const limit = Number.isFinite(parsedLimit) && parsedLimit >= 0
        ? Math.min(Math.floor(parsedLimit), RULE_LOAD_POLICY.maxLimit)
        : RULE_LOAD_POLICY.defaultLimit;

      // One budget, three LAYERS. Ranking the pool flat would let whoever has
      // the most-hit rules take the whole prompt: a big-ruleset teammate would
      // bury the rules you just grew, and a personal favourite would bury what
      // the project requires. So each layer has a floor and is ranked inside it.
      const layerOf = (rs: ReviewRuleset): RuleLayer =>
        rs.kind === "project" ? "project" : rs.ownerId === p.userId ? "own" : "others";
      const contributors = [...(mandatory ? [mandatory] : []), ...own, ...teammates, ...borrowed];
      const pool = contributors.flatMap((rs) =>
        rs.rules.map((rule) => ({ ...rule, rulesetId: rs.id, layer: layerOf(rs) })),
      );
      const ranked = rankLayered(pool, { limit });

      // Freeform focus/instructions always apply and are NOT part of the rule
      // budget — they are per-ruleset prose, not selector-matched rules. Only
      // describe sources that actually contributed a selected rule, plus any
      // whose prose applies, so the skill isn't told about irrelevant rulesets.
      const contributing = new Set(ranked.rules.map((r) => r.rulesetId));
      const names = await displayNames(repo);
      const sources = contributors
        .filter((rs) => contributing.has(rs.id) || rs.focus.trim() || rs.instructions.trim())
        .map((rs) => {
          const layer = layerOf(rs);
          return {
            rulesetId: rs.id,
            name: rs.name,
            // `project` is the new one: rules the project imposes on everyone.
            // `self` is yours; `others` is a teammate's or a named reviewer's.
            origin: layer === "own" ? ("self" as const) : layer,
            // Whose rules these are, in a form worth showing a human — a review
            // says "applied N rules from <person>", and a handle can be a
            // 64-char subject.
            ownerHandle: rs.ownerHandle,
            ownerName: layer === "project" ? "" : names.get(rs.ownerId) || rs.ownerHandle,
            /** Project-level rules are not optional: apply every one that matches. */
            mandatory: layer === "project",
            project: rs.project,
            focus: rs.focus,
            instructions: rs.instructions,
            language: rs.language,
            rulesSelected: ranked.rules.filter((r) => r.rulesetId === rs.id).length,
          };
        });

      return ok({
        ...(project ? { project } : {}),
        ...(reviewer ? { reviewer, reviewerName: resolved.name || reviewer } : {}),
        // Tell the skill when a name went nowhere, so it can say so instead of
        // silently reviewing with nobody's rules.
        ...(rawReviewer && !reviewer
          ? { reviewerInput: rawReviewer, reviewerUnknown: true, reviewerAmbiguous: resolved.ambiguous }
          : {}),
        ruleLimit: limit,
        ruleTotal: ranked.total,
        ruleOmitted: ranked.omitted,
        sources,
        rules: ranked.rules,
      });
    },
  },
  {
    // Public discovery: a user's public rulesets by handle. No auth — this is
    // how the local orchestrator skill fetches "let X review my changes".
    method: "GET",
    pattern: /^\/api\/u\/(?<handle>[^/]+)\/rulesets$/,
    handler: async ({ params, query }, repo) => {
      const all = await repo.listPublicRulesets();
      // Accept a display name here too, but only resolve against people who
      // already own a public ruleset: this route is unauthenticated, and
      // matching against every user would turn it into a name-probing oracle.
      const typed = params.handle!;
      const owners = new Set(all.map((r) => r.ownerHandle));
      const handle = owners.has(slugify(typed))
        ? slugify(typed)
        : (await resolveReviewerHandle(repo, typed, owners)).handle || slugify(typed);
      // Optional project filter: a project-scoped ruleset matches its own key;
      // an "any project" ruleset (project === "") always matches.
      const projectFilter = normalizeProjectKey(query.get("project") ?? "");
      // Cap how many rules a review has to weigh. Without this a long-lived
      // project's auto-grown ruleset keeps growing and every review gets slower
      // for no accuracy gain; `rankRules` keeps the ones that earn their place.
      // `limit=0` is meaningful ("just tell me the totals"), so test the raw
      // string first: Number(null) is 0, which would silently turn a plain
      // request with no ?limit= into "load nothing".
      const rawLimit = query.get("limit");
      const parsedLimit = rawLimit === null || rawLimit === "" ? NaN : Number(rawLimit);
      const limit = Number.isFinite(parsedLimit) && parsedLimit >= 0
        ? Math.min(Math.floor(parsedLimit), RULE_LOAD_POLICY.maxLimit)
        : RULE_LOAD_POLICY.defaultLimit;
      const rulesets = all
        .filter((r) => r.ownerHandle === handle)
        .filter((r) => !projectFilter || r.project === "" || r.project === projectFilter)
        // Strip PII: this endpoint is unauthenticated, so never leak the owner's
        // email or internal id. `handle` is the intended public identifier.
        // Only rules IN EFFECT are exposed (rankRules drops legacy pending and
        // disabled rules), ranked best-first and capped at `limit`.
        .map(({ ownerId: _ownerId, ownerEmail: _ownerEmail, ...pub }) => {
          const ranked = rankRules(pub.rules, { limit });
          return {
            ...pub,
            rules: ranked.rules,
            // Make the cap visible so the skill (and the UI) can say what was
            // left out instead of silently pretending this is the whole set.
            ruleTotal: ranked.total,
            ruleOmitted: ranked.omitted,
          };
        });
      return ok({
        handle,
        ...(projectFilter ? { project: projectFilter } : {}),
        owner: { handle },
        ruleLimit: limit,
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
