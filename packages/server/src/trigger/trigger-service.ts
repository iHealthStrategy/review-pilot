import { randomUUID } from "node:crypto";
import type {
  Platform,
  Project,
  PullRequest,
  ReviewEngineKind,
  ReviewJob,
} from "../domain/entities.js";
import type { Repository } from "../persistence/repository.js";
import type { GitProvider, ProviderPullRequest } from "../providers/git-provider.js";
import type { BranchReviewService } from "../review/branch-review.js";
import {
  type CallbackConfig,
  type CallbackSender,
  deliverCallback,
} from "../review/callback.js";

/** Outcome of creating a review task. */
export type TriggerOutcome =
  | { status: "created"; jobId: string; pullRequestId: string }
  | { status: "deduped"; jobId: string; pullRequestId: string }
  | { status: "accepted"; taskId: string }
  | { status: "ignored"; reason: string };

/**
 * Self-contained review task as received over the API. PR mode when `prNumber`
 * is set; branch-diff mode when `headBranch` + `baseBranch` are set instead.
 */
export interface ReviewTaskInput {
  platform: Platform;
  /** `owner/repo` (GitHub) or `group/.../project` (GitLab) path. */
  repoFullName: string;
  /** Clone URL for syncing the full repo; derived from fullName when omitted. */
  cloneUrl?: string;
  /** PR/MR number to review (PR mode). */
  prNumber?: number;
  /** Head branch (branch-diff mode). */
  headBranch?: string;
  /** Base branch the head is diffed against (branch-diff mode). */
  baseBranch?: string;
  /** Engine override (stored on the job; falls back to the service default). */
  engine?: ReviewEngineKind;
  /** Deliver the result here when the review finishes (branch mode). */
  callback?: CallbackConfig;
}

export interface TaskServiceDeps {
  repo: Repository;
  /** Resolve the provider for a platform (injected for testability). */
  providerFor: (platform: Platform) => GitProvider;
  /** Engine assigned to newly-created jobs when the task omits one. */
  defaultEngine: ReviewEngineKind;
  /** Engines allowed globally (used to seed the internal default project). */
  enabledEngines: ReviewEngineKind[];
  /** Runs branch-diff reviews (required to accept branch-mode tasks). */
  branchReview?: BranchReviewService;
  /** POST seam for callback delivery (defaults to global fetch). */
  callbackSender?: CallbackSender;
  /** Ephemeral task-id generator (injectable for deterministic tests). */
  genId?: () => string;
}

/** Name of the internal project that ad-hoc, API-created repos hang off of. */
const DEFAULT_PROJECT_NAME = "(tasks)";

/**
 * Turns self-contained review requests into deduplicated {@link ReviewJob}s.
 * Tasks carry everything needed (platform, repo, PR number), so no monitored
 * project/repo has to be pre-registered: the service auto-provisions an
 * internal default project and an ad-hoc repo record on first sight, then
 * reuses the existing PR review pipeline. "Same PR seen twice" still creates
 * exactly one active job.
 */
export class TaskService {
  constructor(private readonly deps: TaskServiceDeps) {}

  /**
   * Create a review task. PR mode (prNumber set) enqueues a persistent job
   * that the worker drains and writes back to the PR. Branch-diff mode
   * (headBranch + baseBranch) runs an ephemeral, headless review in the
   * background and delivers the result via the task's callback.
   */
  async createTask(input: ReviewTaskInput): Promise<TriggerOutcome> {
    if (input.prNumber !== undefined) return this.createPrTask(input);
    if (input.headBranch && input.baseBranch) return this.createBranchTask(input);
    return {
      status: "ignored",
      reason: "task must carry either prNumber (PR mode) or headBranch+baseBranch (branch mode)",
    };
  }

  /**
   * Branch-diff mode: kick off an ephemeral background review and return an
   * id immediately. Results are delivered only via the callback (no PR
   * write-back, not shown in the dashboard). Requires a configured
   * branchReview dependency and a callback to deliver to.
   */
  private createBranchTask(input: ReviewTaskInput): TriggerOutcome {
    if (!this.deps.branchReview) {
      return { status: "ignored", reason: "branch-mode reviews are not enabled on this server" };
    }
    if (!input.callback?.url) {
      return { status: "ignored", reason: "branch-mode tasks require a callback.url to deliver the result" };
    }
    const callback = input.callback;
    const taskId = (this.deps.genId ?? (() => `task_${randomUUID()}`))();
    const task = {
      platform: input.platform,
      repoFullName: input.repoFullName,
      cloneUrl: input.cloneUrl ?? deriveCloneUrl(input.platform, input.repoFullName),
      headBranch: input.headBranch!,
      baseBranch: input.baseBranch!,
      ...(input.engine ? { engine: input.engine } : {}),
    };
    // Fire and forget: run the review, then deliver the outcome via callback.
    void this.deps.branchReview
      .review(task)
      .then((res) =>
        deliverCallback(
          callback,
          { taskId, status: "completed", conclusion: res.conclusion, findings: res.findings },
          this.deps.callbackSender,
        ),
      )
      .catch((err) =>
        deliverCallback(
          callback,
          { taskId, status: "failed", error: (err as Error).message },
          this.deps.callbackSender,
        ),
      );
    return { status: "accepted", taskId };
  }

  /** PR mode: upsert an ad-hoc repo + PR record and enqueue a persistent job. */
  private async createPrTask(input: ReviewTaskInput): Promise<TriggerOutcome> {
    const project = await this.ensureDefaultProject();
    let repo = await this.deps.repo.findRepoByFullName(
      input.platform,
      input.repoFullName,
    );
    if (!repo) {
      repo = await this.deps.repo.createRepo({
        projectId: project.id,
        platform: input.platform,
        fullName: input.repoFullName,
        remoteUrl: deriveRemoteUrl(input.platform, input.repoFullName),
        cloneUrl: input.cloneUrl ?? deriveCloneUrl(input.platform, input.repoFullName),
        defaultBranch: "main",
      });
    }

    const provider = this.deps.providerFor(input.platform);
    const meta = await provider.getPullRequest(
      { fullName: repo.fullName },
      input.prNumber!,
    );
    const pr = await this.deps.repo.upsertPullRequest({
      repoId: repo.id,
      ...prFields(meta),
    });
    return this.enqueue(pr, input.engine);
  }

  /** Find (or lazily create) the internal project ad-hoc repos hang off of. */
  private async ensureDefaultProject(): Promise<Project> {
    const existing = (await this.deps.repo.listProjects()).find(
      (p) => p.name === DEFAULT_PROJECT_NAME,
    );
    if (existing) return existing;
    return this.deps.repo.createProject({
      name: DEFAULT_PROJECT_NAME,
      platform: "github",
      defaultEngine: this.deps.defaultEngine,
      enabledEngines: this.deps.enabledEngines,
    });
  }

  /** Create a job for a PR unless one is already pending/running. */
  private async enqueue(
    pr: PullRequest,
    engine?: ReviewEngineKind,
  ): Promise<TriggerOutcome> {
    const jobs = await this.deps.repo.listReviewJobs({ pullRequestId: pr.id });
    const active = jobs.find(
      (j: ReviewJob) => j.status === "pending" || j.status === "running",
    );
    if (active) {
      return { status: "deduped", jobId: active.id, pullRequestId: pr.id };
    }
    const job = await this.deps.repo.createReviewJob({
      pullRequestId: pr.id,
      engine: engine ?? this.deps.defaultEngine,
    });
    return { status: "created", jobId: job.id, pullRequestId: pr.id };
  }
}

function prFields(meta: ProviderPullRequest) {
  return {
    number: meta.number,
    title: meta.title,
    sourceBranch: meta.sourceBranch,
    targetBranch: meta.targetBranch,
    headSha: meta.headSha,
    author: meta.author,
    url: meta.url,
    state: meta.state,
  };
}

/** Best-effort web URL for an ad-hoc repo (display only). */
function deriveRemoteUrl(platform: Platform, fullName: string): string {
  const host = platform === "gitlab" ? "https://gitlab.com" : "https://github.com";
  return `${host}/${fullName}`;
}

/** Best-effort clone URL when the task didn't carry one. */
function deriveCloneUrl(platform: Platform, fullName: string): string {
  return `${deriveRemoteUrl(platform, fullName)}.git`;
}
