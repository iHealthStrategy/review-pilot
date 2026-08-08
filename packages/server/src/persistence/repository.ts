import { randomUUID } from "node:crypto";
import type {
  ApiToken,
  Finding,
  JobStatus,
  Platform,
  Project,
  PullRequest,
  PullRequestState,
  Repo,
  RepoInsight,
  ReviewEngineKind,
  ReviewJob,
  ReviewRule,
  ReviewRuleset,
  RulesetVisibility,
  Severity,
  SkillFinding,
  SkillScope,
  SkillUsage,
  TokenUsage,
  UsageSource,
  User,
  UserRole,
} from "../domain/entities.js";

/** Monotonic-ish clock returning ISO timestamps; injectable for tests. */
export type Clock = () => string;

/** Id generator taking an entity prefix; injectable for tests. */
export type IdGen = (prefix: string) => string;

/** Default clock backed by the system wall clock. */
export const systemClock: Clock = () => new Date().toISOString();

/** Default id generator: `<prefix>_<uuid>`. */
export const uuidIdGen: IdGen = (prefix) => `${prefix}_${randomUUID()}`;

export interface CreateProjectInput {
  name: string;
  platform: Platform;
  defaultEngine: ReviewEngineKind;
  enabledEngines: ReviewEngineKind[];
}

export interface CreateRepoInput {
  projectId: string;
  platform: Platform;
  fullName: string;
  remoteUrl: string;
  cloneUrl: string;
  defaultBranch: string;
}

export interface UpsertPullRequestInput {
  repoId: string;
  number: number;
  title: string;
  sourceBranch: string;
  targetBranch: string;
  headSha: string;
  author: string;
  url: string;
  state: PullRequestState;
}

export interface CreateReviewJobInput {
  pullRequestId: string;
  engine: ReviewEngineKind;
}

export interface AddFindingInput {
  filePath: string;
  line?: number;
  endLine?: number;
  severity: Severity;
  title: string;
  detail: string;
  suggestion?: string;
  category?: string;
}

export interface UpsertRepoInsightInput {
  repoId: string;
  summary: string;
  headSha: string;
}

export interface CreateUserInput {
  email: string;
  /** Unique public handle (caller ensures uniqueness). */
  handle: string;
  /** Human display name from the IdP; "" when unknown. */
  name: string;
  /** External IdP subject (OIDC `sub`); "" when not yet linked. */
  externalId: string;
  role: UserRole;
}

export interface CreateApiTokenInput {
  userId: string;
  name: string;
  /** SHA-256 of the secret; the plaintext is never persisted. */
  tokenHash: string;
  prefix: string;
}

export interface RecordTokenUsageInput {
  source: UsageSource;
  sourceId: string;
  sourceLabel: string;
  engine: ReviewEngineKind;
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
  /** Defaults to now when omitted (injectable for tests). */
  at?: string;
}

export interface TokenUsageFilter {
  source?: UsageSource;
  sourceId?: string;
  /** ISO lower bound (inclusive) — bound the scan window for aggregation. */
  since?: string;
}

export interface RecordSkillUsageInput {
  userId: string;
  userLabel: string;
  project: string;
  scope: SkillScope;
  critical: number;
  major: number;
  minor: number;
  info: number;
  /** Wall-clock ms for the run; omit when the reporting skill didn't measure it. */
  durationMs?: number;
  /** Wall-clock ms minus time waiting on user input; omit when not measured. */
  activeMs?: number;
  /** Size of the reviewed change, so counts and durations become comparable. */
  filesChanged?: number;
  linesChanged?: number;
  /** One-shot fix pass: fixes offered, and fixes the user accepted. */
  fixesProposed?: number;
  fixesApplied?: number;
  /** Groups repeated reviews of the SAME change (see SkillUsage.changeKey). */
  changeKey?: string;
  /** The findings themselves; omit or pass [] for a counts-only report. */
  findings?: readonly SkillFinding[];
  /** Defaults to now when omitted (injectable for tests). */
  at?: string;
}

/**
 * The optional measurement fields of a skill run, normalized into the shape a
 * `SkillUsage` stores. Shared by every backend so a new optional field is added
 * in one place instead of four, and so "not reported" stays `undefined` rather
 * than silently becoming 0 — the aggregations rely on that distinction.
 */
export function skillUsageMetrics(input: RecordSkillUsageInput): Partial<SkillUsage> {
  const num = (v: number | undefined) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of [
    ["durationMs", num(input.durationMs)],
    ["activeMs", num(input.activeMs)],
    ["filesChanged", num(input.filesChanged)],
    ["linesChanged", num(input.linesChanged)],
    ["fixesProposed", num(input.fixesProposed)],
    ["fixesApplied", num(input.fixesApplied)],
    ["changeKey", input.changeKey || undefined],
  ] as const) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<SkillUsage>;
}

export interface SkillUsageFilter {
  /** Scope to one user (non-admin self view); omit for all users (admin). */
  userId?: string;
  /** Scope to one project key; omit for every project. */
  project?: string;
  /** ISO lower bound (inclusive) — bound the scan window for aggregation. */
  since?: string;
  /** Cap the number of (most recent) rows returned; omit for all of them. */
  limit?: number;
}

export interface CreateRulesetInput {
  ownerId: string;
  ownerEmail: string;
  ownerHandle: string;
  /** Normalized project key ("" = any project). */
  project: string;
  /** Human-facing project label (display only). */
  projectLabel: string;
  name: string;
  slug: string;
  description: string;
  visibility: RulesetVisibility;
  language: string;
  focus: string;
  instructions: string;
  rules: ReviewRule[];
}

/** Editable fields (slug + owner + project are immutable). */
export interface UpdateRulesetPatch {
  name?: string;
  description?: string;
  visibility?: RulesetVisibility;
  language?: string;
  focus?: string;
  instructions?: string;
  rules?: ReviewRule[];
  projectLabel?: string;
}

/** Mutable fields that may accompany a job state transition. */
export interface ReviewJobPatch {
  progress?: number;
  error?: string;
}

export interface ReviewJobFilter {
  status?: JobStatus;
  pullRequestId?: string;
}

/**
 * Persistence port. Every backend (memory/file/SQL) implements this exact
 * contract and is exercised by the shared contract test, guaranteeing the
 * driver is switchable without behavioural drift.
 */
export interface Repository {
  /** Idempotently prepare storage (load file / run migrations). */
  init(): Promise<void>;

  createProject(input: CreateProjectInput): Promise<Project>;
  getProject(id: string): Promise<Project | null>;
  listProjects(): Promise<Project[]>;

  createRepo(input: CreateRepoInput): Promise<Repo>;
  getRepo(id: string): Promise<Repo | null>;
  listReposByProject(projectId: string): Promise<Repo[]>;
  listRepos(): Promise<Repo[]>;
  /** Match an inbound event to a stored repo by platform + full path. */
  findRepoByFullName(platform: Platform, fullName: string): Promise<Repo | null>;

  /** Create-or-update a PR, deduplicated by (repoId, number). */
  upsertPullRequest(input: UpsertPullRequestInput): Promise<PullRequest>;
  getPullRequest(id: string): Promise<PullRequest | null>;
  findPullRequest(repoId: string, number: number): Promise<PullRequest | null>;

  createReviewJob(input: CreateReviewJobInput): Promise<ReviewJob>;
  getReviewJob(id: string): Promise<ReviewJob | null>;
  listReviewJobs(filter?: ReviewJobFilter): Promise<ReviewJob[]>;
  /** Enforce the state machine; apply optional patch + lifecycle timestamps. */
  transitionReviewJob(
    id: string,
    to: JobStatus,
    patch?: ReviewJobPatch,
  ): Promise<ReviewJob>;
  /**
   * Atomically take the oldest `pending` job and move it to `running`
   * (incrementing attempts, stamping `startedAt`), returning it — or null when
   * none are pending. This is the queue primitive that lets multiple stateless
   * workers drain the same queue without double-processing a job.
   */
  claimNextPendingJob(): Promise<ReviewJob | null>;
  appendJobLog(id: string, line: string): Promise<void>;
  /** Update coarse progress (0..100) without a status transition. */
  setReviewJobProgress(id: string, progress: number): Promise<ReviewJob>;

  addFindings(
    reviewJobId: string,
    findings: AddFindingInput[],
  ): Promise<Finding[]>;
  listFindings(reviewJobId: string): Promise<Finding[]>;

  /** Cached per-repo project understanding (null if never generated). */
  getRepoInsight(repoId: string): Promise<RepoInsight | null>;
  /** Create-or-replace the cached understanding for a repo. */
  upsertRepoInsight(input: UpsertRepoInsightInput): Promise<RepoInsight>;

  // --- Users & API tokens (multi-user auth) ---
  createUser(input: CreateUserInput): Promise<User>;
  getUserById(id: string): Promise<User | null>;
  getUserByEmail(email: string): Promise<User | null>;
  getUserByHandle(handle: string): Promise<User | null>;
  /** Look up by external IdP subject (OIDC `sub`); null when unlinked/unknown. */
  getUserByExternalId(externalId: string): Promise<User | null>;
  listUsers(): Promise<User[]>;
  /** Total user count — used to bootstrap the first user as admin. */
  countUsers(): Promise<number>;
  updateUserRole(id: string, role: UserRole): Promise<User>;
  /** Link an existing account to an external IdP subject (first OIDC login). */
  setUserExternalId(id: string, externalId: string): Promise<User>;
  /** Refresh the display name from the IdP (kept current on each login). */
  setUserName(id: string, name: string): Promise<User>;

  createApiToken(input: CreateApiTokenInput): Promise<ApiToken>;
  listApiTokensByUser(userId: string): Promise<ApiToken[]>;
  /** Resolve a presented token to its record by SHA-256 hash (auth path). */
  getApiTokenByHash(tokenHash: string): Promise<ApiToken | null>;
  /** Revoke a token, scoped to its owner so users can't delete others'. */
  deleteApiToken(id: string, userId: string): Promise<void>;
  /** Best-effort lastUsedAt stamp on a successful token auth. */
  touchApiToken(id: string, at: string): Promise<void>;

  // --- Token usage (per-task LLM consumption) ---
  recordTokenUsage(input: RecordTokenUsageInput): Promise<TokenUsage>;
  /** Raw usage records (newest first), bounded/filtered for aggregation. */
  listTokenUsage(filter?: TokenUsageFilter): Promise<TokenUsage[]>;

  // --- Skill usage (local review-skill runs, attributed per user) ---
  recordSkillUsage(input: RecordSkillUsageInput): Promise<SkillUsage>;
  /** Raw skill-usage records (newest first), filtered by user/since. */
  listSkillUsage(filter?: SkillUsageFilter): Promise<SkillUsage[]>;

  // --- Community review rulesets ---
  createRuleset(input: CreateRulesetInput): Promise<ReviewRuleset>;
  getRuleset(id: string): Promise<ReviewRuleset | null>;
  listRulesetsByOwner(ownerId: string): Promise<ReviewRuleset[]>;
  /** The owner's ruleset for a given project key, or null (auto-grow upsert). */
  findRulesetByOwnerAndProject(
    ownerId: string,
    project: string,
  ): Promise<ReviewRuleset | null>;
  listPublicRulesets(): Promise<ReviewRuleset[]>;
  /** Update is owner-scoped: a non-owner edit throws EntityNotFoundError. */
  updateRuleset(id: string, ownerId: string, patch: UpdateRulesetPatch): Promise<ReviewRuleset>;
  deleteRuleset(id: string, ownerId: string): Promise<void>;

  /** Release resources (close DB handle / flush file). */
  close(): Promise<void>;
}

/** Thrown when an operation references a missing entity. */
export class EntityNotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`);
    this.name = "EntityNotFoundError";
  }
}
