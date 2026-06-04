import type { Platform, PullRequestState } from "../domain/entities.js";

/** Identifies a repository to a provider in a platform-neutral way. */
export interface RepoRef {
  /** `owner/repo` (GitHub) or `group/subgroup/project` (GitLab) path. */
  fullName: string;
}

/** Normalised pull/merge request as returned by any provider. */
export interface ProviderPullRequest {
  /** Platform-native PR/MR number (GitHub PR number, GitLab MR iid). */
  number: number;
  title: string;
  sourceBranch: string;
  targetBranch: string;
  headSha: string;
  author: string;
  url: string;
  state: PullRequestState;
}

/** Per-file change in a PR/MR, normalised across platforms. */
export type DiffFileStatus = "added" | "modified" | "removed" | "renamed";
export interface DiffFile {
  path: string;
  previousPath?: string;
  status: DiffFileStatus;
  additions?: number;
  deletions?: number;
  /** Unified-diff hunk text when the platform provides it. */
  patch?: string;
}

/** Raw inbound webhook, captured before any parsing. */
export interface WebhookRequest {
  /** Header names MUST be lower-cased by the caller. */
  headers: Record<string, string>;
  /** Exact raw request body (required for signature verification). */
  rawBody: string;
}

export interface WebhookVerification {
  valid: boolean;
  reason?: string;
}

/** A pull/merge-request event extracted from a verified webhook. */
export interface PullRequestEvent {
  platform: Platform;
  repoFullName: string;
  number: number;
  action: string;
  headSha: string;
  /** True when the action should (re)trigger a review (opened/updated/etc). */
  reviewable: boolean;
  /** True when the PR/MR is closing/merging — pending reviews should cancel. */
  closing?: boolean;
}

/** A posted comment as echoed back by the provider. */
export interface ProviderComment {
  id: string;
  url?: string;
  /** Comment body when listed (used to find a prior ReviewPilot summary). */
  body?: string;
}

/** A line-level review comment anchored to a file/line at a commit. */
export interface InlineCommentInput {
  path: string;
  line: number;
  body: string;
  /** Head commit the line refers to. */
  commitSha: string;
}

/** A line-anchored annotation shown inline on the PR's Files-changed tab. */
export interface CheckAnnotation {
  path: string;
  startLine: number;
  endLine: number;
  level: "notice" | "warning" | "failure";
  title?: string;
  message: string;
}

/** Result of a completed review, published as a commit/PR status check. */
export type CheckConclusion = "success" | "failure" | "neutral";
export interface CheckRunInput {
  /** Check name shown on the PR (e.g. "ReviewPilot"). */
  name: string;
  /** Head commit the check is reported against. */
  headSha: string;
  conclusion: CheckConclusion;
  title: string;
  /** Markdown summary body. */
  summary: string;
  /** Per-finding inline annotations (file/line). */
  annotations?: CheckAnnotation[];
}

/**
 * Unified Git platform abstraction. Every supported platform (GitHub, GitLab)
 * implements this exact port; the rest of the system is platform-agnostic.
 */
export interface GitProvider {
  readonly platform: Platform;

  /** Verify a webhook's authenticity (HMAC for GitHub, token for GitLab). */
  verifyWebhook(req: WebhookRequest): WebhookVerification;
  /** Extract a normalised PR event, or null if not a PR/MR event. */
  parseWebhook(req: WebhookRequest): PullRequestEvent | null;

  getPullRequest(repo: RepoRef, number: number): Promise<ProviderPullRequest>;
  getPullRequestDiff(repo: RepoRef, number: number): Promise<DiffFile[]>;
  /** Open PR/MRs — used by the polling fallback to discover new work. */
  listOpenPullRequests(repo: RepoRef): Promise<ProviderPullRequest[]>;

  /** Post a summary (issue-level) comment back to the PR/MR. */
  postComment(
    repo: RepoRef,
    number: number,
    body: string,
  ): Promise<ProviderComment>;

  /** List existing summary-level comments. Enables update-in-place dedup. */
  listComments?(repo: RepoRef, number: number): Promise<ProviderComment[]>;
  /** Edit an existing summary-level comment on a PR/MR by id. */
  updateComment?(
    repo: RepoRef,
    number: number,
    commentId: string,
    body: string,
  ): Promise<ProviderComment>;

  /** Post a line-level comment. Optional: not all setups enable inline review. */
  postInlineComment?(
    repo: RepoRef,
    number: number,
    input: InlineCommentInput,
  ): Promise<ProviderComment>;

  /** Publish a completed status check for the head commit. Optional: enables
   * a PR ✅/❌ gate. Returns the created check's id/url. */
  createCheckRun?(repo: RepoRef, input: CheckRunInput): Promise<ProviderComment>;

  /** Authenticated clone URL for syncing the full repository. May mint a
   * short-lived token (e.g. GitHub App), hence async. */
  cloneUrl(repo: RepoRef): Promise<string>;
}
