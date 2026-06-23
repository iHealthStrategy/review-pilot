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
  /** Pre-hashed (scrypt) — the repository never sees plaintext passwords. */
  passwordHash: string;
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
  listUsers(): Promise<User[]>;
  /** Total user count — used to bootstrap the first user as admin. */
  countUsers(): Promise<number>;
  updateUserRole(id: string, role: UserRole): Promise<User>;

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
