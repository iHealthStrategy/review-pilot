/**
 * Core domain entities for ReviewPilot.
 *
 * These types are persistence-agnostic: every repository backend
 * (in-memory, file, SQL) stores and returns exactly these shapes. Timestamps
 * are ISO-8601 strings so they round-trip losslessly through JSON and SQL TEXT
 * columns without driver-specific Date handling.
 */

/** Git hosting platforms supported by the multi-platform abstraction. */
export type Platform = "github" | "gitlab";

/** Pluggable review engines (mirrors the config union intentionally). */
export type ReviewEngineKind =
  | "mock"
  | "cursor"
  | "claude-code"
  | "claude-agent"
  | "codex";

/** Lifecycle of a review job. See {@link ./state-machine.ts}. */
export type JobStatus = "pending" | "running" | "succeeded" | "failed";

/** Open/closed/merged state of a pull/merge request. */
export type PullRequestState = "open" | "closed" | "merged";

/** Severity ranking for a single finding. */
export type Severity = "info" | "minor" | "major" | "critical";

/** A monitored project — the unit users configure in the Web UI. */
export interface Project {
  readonly id: string;
  readonly name: string;
  readonly platform: Platform;
  /** Default engine used when a job does not specify one. */
  readonly defaultEngine: ReviewEngineKind;
  /** Engines allowed to be selected for this project. */
  readonly enabledEngines: ReviewEngineKind[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A repository belonging to a project. */
export interface Repo {
  readonly id: string;
  readonly projectId: string;
  readonly platform: Platform;
  /** `owner/repo` (GitHub) or `group/.../project` (GitLab) path — the stable
   * key used to match inbound webhook/polling events to this repo. */
  readonly fullName: string;
  /** Human-facing remote URL (web). */
  readonly remoteUrl: string;
  /** Clone URL used by the worker to sync the full repository. */
  readonly cloneUrl: string;
  readonly defaultBranch: string;
  readonly createdAt: string;
}

/** A pull/merge request observed on a repo. Unique per (repoId, number). */
export interface PullRequest {
  readonly id: string;
  readonly repoId: string;
  /** Platform-native PR/MR number. */
  readonly number: number;
  readonly title: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly headSha: string;
  readonly author: string;
  readonly url: string;
  readonly state: PullRequestState;
  readonly createdAt: string;
}

/** A review task created for a PR, executed by the worker. */
export interface ReviewJob {
  readonly id: string;
  readonly pullRequestId: string;
  readonly engine: ReviewEngineKind;
  readonly status: JobStatus;
  /** Times the job has entered `running` (retries increment this). */
  readonly attempts: number;
  /** Coarse progress 0..100 for the Jenkins-like UI. */
  readonly progress: number;
  /** Failure message when status is `failed`. */
  readonly error?: string;
  /** Append-only execution log lines. */
  readonly logs: string[];
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

/**
 * Cached whole-project understanding for a repo — a summary the agentic engine
 * produces by exploring the codebase, reused across PR reviews (refreshed on a
 * TTL) so each review is grounded in global context without re-exploring.
 * One per repo, keyed by `repoId`.
 */
export interface RepoInsight {
  readonly repoId: string;
  readonly summary: string;
  /** Head sha the summary was generated against (provenance). */
  readonly headSha: string;
  readonly updatedAt: string;
}

/**
 * Access level of a user. Ranked: viewer < member < admin.
 *  - `viewer`: read-only (all GET endpoints). Default for self-registration.
 *  - `member`: viewer + may create/edit/run (mutating endpoints).
 *  - `admin`:  member + manage users (upgrade roles). The first registered
 *    user is bootstrapped to admin so there is always someone who can upgrade.
 */
export type UserRole = "viewer" | "member" | "admin";

/** A registered account. `passwordHash` never leaves the persistence layer. */
export interface User {
  readonly id: string;
  readonly email: string;
  /** Public, unique handle (e.g. for community discovery `…/u/<handle>`). */
  readonly handle: string;
  /** scrypt hash, encoded `<saltHex>:<hashHex>`. Never serialized to the API. */
  readonly passwordHash: string;
  readonly role: UserRole;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * A personal access token a user mints for API/automation use. Only the SHA-256
 * `tokenHash` is stored; the plaintext secret is shown once at creation. `prefix`
 * is the leading, non-secret part kept for display (e.g. `rpat_ab12cd`).
 */
export interface ApiToken {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly tokenHash: string;
  readonly prefix: string;
  readonly createdAt: string;
  readonly lastUsedAt?: string;
}

/** What a token-usage record is attributed to. */
export type UsageSource = "schedule" | "task";

/**
 * One LLM token-usage record, emitted per review run (per branch for scans).
 * `estimated` marks counts derived from text length (chars/4) rather than
 * reported by the engine. Aggregated by day/week/month for the usage view.
 */
export interface TokenUsage {
  readonly id: string;
  readonly source: UsageSource;
  /** Schedule id (scans) or repo full name (ad-hoc tasks). */
  readonly sourceId: string;
  /** Human-facing label (schedule name or repo). */
  readonly sourceLabel: string;
  readonly engine: ReviewEngineKind;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly estimated: boolean;
  readonly at: string;
}

/** The scope the local review skill ran over. */
export type SkillScope = "working" | "branch" | "whole";

/**
 * One run of the local review skill (the orchestrator running in a user's own
 * Claude Code), reported back to the platform per review. Deliberately carries
 * NO token counts — the local session can't measure them; it records the run,
 * its scope, and the findings it reported by severity, attributed to the user.
 * Admins aggregate these per user; a user sees only their own.
 */
export interface SkillUsage {
  readonly id: string;
  /** Reporting user (the caller's principal). */
  readonly userId: string;
  /** Human-facing attribution for display (e.g. "@handle" or email). */
  readonly userLabel: string;
  /** Normalized project key the review ran against ("" = unknown). */
  readonly project: string;
  readonly scope: SkillScope;
  /** Reported findings counted by severity (total = sum of the four). */
  readonly critical: number;
  readonly major: number;
  readonly minor: number;
  readonly info: number;
  readonly at: string;
}

/** Visibility of a community review ruleset. */
export type RulesetVisibility = "private" | "public";

/**
 * One review rule with selectors for on-demand loading. A rule applies to a
 * change when its selectors match the changed files; empty selectors = always
 * considered. Matching happens locally in the skill, so code never leaves the
 * machine. `topics` are semantic hints the model uses to judge relevance.
 */
export interface ReviewRule {
  readonly title: string;
  readonly instruction: string;
  /** Path globs (e.g. `src/db/**`, `**` + `/*.sql`); empty = any path. */
  readonly globs: string[];
  /** Languages by extension family (e.g. "sql", "python"); empty = any. */
  readonly languages: string[];
  /** Semantic topics (e.g. "security", "performance"); empty = always. */
  readonly topics: string[];
  /**
   * Auto-extracted candidate rule awaiting the owner's confirmation. Pending
   * rules are stored (auto-submitted by the skill) but NOT applied during review
   * and NOT exposed via public discovery until the owner promotes them.
   */
  readonly pending?: boolean;
}

/**
 * A user-authored set of review rules/preferences. The platform turns it into a
 * local Claude Code skill (named `reviewpilot-<slug>`). Public rulesets are
 * browsable + installable by anyone (the "community"); private ones need the
 * owner's token to install.
 */
export interface ReviewRuleset {
  readonly id: string;
  readonly ownerId: string;
  /** Denormalized for community display. */
  readonly ownerEmail: string;
  /** Denormalized owner handle — the community discovery key (`…/u/<handle>`). */
  readonly ownerHandle: string;
  /**
   * Normalized project key this ruleset governs (e.g. `github.com/acme/app`,
   * derived from the git remote). Rules are managed per project; "" = applies to
   * any project. A user has at most one ruleset per (owner, project) for the
   * skill's auto-grown candidates, but may create more manually.
   */
  readonly project: string;
  /** Human-facing project label (e.g. the repo full name); display only. */
  readonly projectLabel: string;
  readonly name: string;
  /** Stable, filesystem-safe slug for the skill name (immutable after create). */
  readonly slug: string;
  readonly description: string;
  readonly visibility: RulesetVisibility;
  /** Output language for findings ("" = follow the user). */
  readonly language: string;
  /** Short review emphasis (prioritised in the skill). */
  readonly focus: string;
  /** Freeform rules (markdown) that ALWAYS apply, woven into the skill. */
  readonly instructions: string;
  /** Structured rules with selectors — loaded on demand by relevance. */
  readonly rules: ReviewRule[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A structured review result item (the "issue list + suggestion"). */
export interface Finding {
  readonly id: string;
  readonly reviewJobId: string;
  readonly filePath: string;
  readonly line?: number;
  readonly endLine?: number;
  readonly severity: Severity;
  readonly title: string;
  readonly detail: string;
  readonly suggestion?: string;
  readonly category?: string;
}
