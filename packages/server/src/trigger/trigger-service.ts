import type {
  Platform,
  Project,
  PullRequest,
  ReviewEngineKind,
  ReviewJob,
} from "../domain/entities.js";
import type { Repository } from "../persistence/repository.js";
import type { GitProvider, ProviderPullRequest } from "../providers/git-provider.js";

/** Outcome of creating a review task. */
export type TriggerOutcome =
  | { status: "created"; jobId: string; pullRequestId: string }
  | { status: "deduped"; jobId: string; pullRequestId: string }
  | { status: "ignored"; reason: string };

/** Self-contained review task as received over the API. */
export interface ReviewTaskInput {
  platform: Platform;
  /** `owner/repo` (GitHub) or `group/.../project` (GitLab) path. */
  repoFullName: string;
  /** Clone URL for syncing the full repo; derived from fullName when omitted. */
  cloneUrl?: string;
  /** PR/MR number to review (PR mode). */
  prNumber: number;
  /** Engine override (stored on the job; falls back to the service default). */
  engine?: ReviewEngineKind;
}

export interface TaskServiceDeps {
  repo: Repository;
  /** Resolve the provider for a platform (injected for testability). */
  providerFor: (platform: Platform) => GitProvider;
  /** Engine assigned to newly-created jobs when the task omits one. */
  defaultEngine: ReviewEngineKind;
  /** Engines allowed globally (used to seed the internal default project). */
  enabledEngines: ReviewEngineKind[];
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
   * Create (or dedupe) a review job for a self-contained task. Fetches PR
   * metadata from the provider, upserts an ad-hoc repo + PR record, and
   * enqueues the job.
   */
  async createTask(input: ReviewTaskInput): Promise<TriggerOutcome> {
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
      input.prNumber,
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
