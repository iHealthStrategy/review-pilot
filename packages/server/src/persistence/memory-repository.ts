import type {
  Finding,
  JobStatus,
  Platform,
  Project,
  PullRequest,
  Repo,
  RepoInsight,
  ReviewJob,
} from "../domain/entities.js";
import { assertTransition } from "../domain/state-machine.js";
import {
  type AddFindingInput,
  type Clock,
  type CreateProjectInput,
  type CreateRepoInput,
  type CreateReviewJobInput,
  EntityNotFoundError,
  type IdGen,
  type Repository,
  type ReviewJobFilter,
  type ReviewJobPatch,
  type UpsertPullRequestInput,
  type UpsertRepoInsightInput,
  systemClock,
  uuidIdGen,
} from "./repository.js";

/** Plain, JSON-serialisable snapshot of all stored entities. */
export interface MemorySnapshot {
  projects: Record<string, Project>;
  repos: Record<string, Repo>;
  pullRequests: Record<string, PullRequest>;
  reviewJobs: Record<string, ReviewJob>;
  findings: Record<string, Finding>;
  /** Cached per-repo project understanding, keyed by repoId. */
  repoInsights: Record<string, RepoInsight>;
}

function emptySnapshot(): MemorySnapshot {
  return {
    projects: {},
    repos: {},
    pullRequests: {},
    reviewJobs: {},
    findings: {},
    repoInsights: {},
  };
}

export interface MemoryRepositoryOptions {
  clock?: Clock;
  idGen?: IdGen;
}

/**
 * In-memory repository — the default `mock`-mode backend. Also the base class
 * for {@link FileRepository}, which adds durability via the `load`/`persist`
 * hooks. All mutations call `persist()` (a no-op here) so the file backend can
 * write through without re-implementing any business logic.
 */
export class MemoryRepository implements Repository {
  protected data: MemorySnapshot = emptySnapshot();
  protected readonly clock: Clock;
  protected readonly idGen: IdGen;

  constructor(options: MemoryRepositoryOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.idGen = options.idGen ?? uuidIdGen;
  }

  async init(): Promise<void> {
    await this.load();
  }

  /** Hook: load persisted state. No-op for pure in-memory. */
  protected async load(): Promise<void> {
    /* in-memory: nothing to load */
  }

  /** Hook: persist current state. No-op for pure in-memory. */
  protected async persist(): Promise<void> {
    /* in-memory: nothing to persist */
  }

  async createProject(input: CreateProjectInput): Promise<Project> {
    const now = this.clock();
    const project: Project = {
      id: this.idGen("prj"),
      name: input.name,
      platform: input.platform,
      defaultEngine: input.defaultEngine,
      enabledEngines: [...input.enabledEngines],
      createdAt: now,
      updatedAt: now,
    };
    this.data.projects[project.id] = project;
    await this.persist();
    return project;
  }

  async getProject(id: string): Promise<Project | null> {
    return this.data.projects[id] ?? null;
  }

  async listProjects(): Promise<Project[]> {
    return Object.values(this.data.projects);
  }

  async createRepo(input: CreateRepoInput): Promise<Repo> {
    if (!this.data.projects[input.projectId]) {
      throw new EntityNotFoundError("Project", input.projectId);
    }
    const repo: Repo = {
      id: this.idGen("repo"),
      projectId: input.projectId,
      platform: input.platform,
      fullName: input.fullName,
      remoteUrl: input.remoteUrl,
      cloneUrl: input.cloneUrl,
      defaultBranch: input.defaultBranch,
      createdAt: this.clock(),
    };
    this.data.repos[repo.id] = repo;
    await this.persist();
    return repo;
  }

  async getRepo(id: string): Promise<Repo | null> {
    return this.data.repos[id] ?? null;
  }

  async listReposByProject(projectId: string): Promise<Repo[]> {
    return Object.values(this.data.repos).filter(
      (r) => r.projectId === projectId,
    );
  }

  async listRepos(): Promise<Repo[]> {
    return Object.values(this.data.repos);
  }

  async findRepoByFullName(
    platform: Platform,
    fullName: string,
  ): Promise<Repo | null> {
    return (
      Object.values(this.data.repos).find(
        (r) => r.platform === platform && r.fullName === fullName,
      ) ?? null
    );
  }

  async upsertPullRequest(
    input: UpsertPullRequestInput,
  ): Promise<PullRequest> {
    const existing = await this.findPullRequest(input.repoId, input.number);
    if (existing) {
      const updated: PullRequest = { ...existing, ...input };
      this.data.pullRequests[existing.id] = updated;
      await this.persist();
      return updated;
    }
    if (!this.data.repos[input.repoId]) {
      throw new EntityNotFoundError("Repo", input.repoId);
    }
    const pr: PullRequest = {
      id: this.idGen("pr"),
      repoId: input.repoId,
      number: input.number,
      title: input.title,
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
      headSha: input.headSha,
      author: input.author,
      url: input.url,
      state: input.state,
      createdAt: this.clock(),
    };
    this.data.pullRequests[pr.id] = pr;
    await this.persist();
    return pr;
  }

  async getPullRequest(id: string): Promise<PullRequest | null> {
    return this.data.pullRequests[id] ?? null;
  }

  async findPullRequest(
    repoId: string,
    number: number,
  ): Promise<PullRequest | null> {
    return (
      Object.values(this.data.pullRequests).find(
        (p) => p.repoId === repoId && p.number === number,
      ) ?? null
    );
  }

  async createReviewJob(input: CreateReviewJobInput): Promise<ReviewJob> {
    if (!this.data.pullRequests[input.pullRequestId]) {
      throw new EntityNotFoundError("PullRequest", input.pullRequestId);
    }
    const job: ReviewJob = {
      id: this.idGen("job"),
      pullRequestId: input.pullRequestId,
      engine: input.engine,
      status: "pending",
      attempts: 0,
      progress: 0,
      logs: [],
      createdAt: this.clock(),
    };
    this.data.reviewJobs[job.id] = job;
    await this.persist();
    return job;
  }

  async getReviewJob(id: string): Promise<ReviewJob | null> {
    return this.data.reviewJobs[id] ?? null;
  }

  async listReviewJobs(filter: ReviewJobFilter = {}): Promise<ReviewJob[]> {
    return Object.values(this.data.reviewJobs).filter((j) => {
      if (filter.status && j.status !== filter.status) return false;
      if (filter.pullRequestId && j.pullRequestId !== filter.pullRequestId) {
        return false;
      }
      return true;
    });
  }

  async transitionReviewJob(
    id: string,
    to: JobStatus,
    patch: ReviewJobPatch = {},
  ): Promise<ReviewJob> {
    const job = this.data.reviewJobs[id];
    if (!job) throw new EntityNotFoundError("ReviewJob", id);
    assertTransition(job.status, to);

    const now = this.clock();
    const next: ReviewJob = {
      ...job,
      status: to,
      attempts: to === "running" ? job.attempts + 1 : job.attempts,
      progress: patch.progress ?? job.progress,
      error: patch.error ?? job.error,
      startedAt: to === "running" && !job.startedAt ? now : job.startedAt,
      finishedAt:
        to === "succeeded" || to === "failed" ? now : job.finishedAt,
    };
    this.data.reviewJobs[id] = next;
    await this.persist();
    return next;
  }

  async claimNextPendingJob(): Promise<ReviewJob | null> {
    const next = Object.values(this.data.reviewJobs)
      .filter((j) => j.status === "pending")
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0];
    if (!next) return null;
    return this.transitionReviewJob(next.id, "running");
  }

  async appendJobLog(id: string, line: string): Promise<void> {
    const job = this.data.reviewJobs[id];
    if (!job) throw new EntityNotFoundError("ReviewJob", id);
    this.data.reviewJobs[id] = { ...job, logs: [...job.logs, line] };
    await this.persist();
  }

  async setReviewJobProgress(id: string, progress: number): Promise<ReviewJob> {
    const job = this.data.reviewJobs[id];
    if (!job) throw new EntityNotFoundError("ReviewJob", id);
    const clamped = Math.max(0, Math.min(100, progress));
    const next: ReviewJob = { ...job, progress: clamped };
    this.data.reviewJobs[id] = next;
    await this.persist();
    return next;
  }

  async addFindings(
    reviewJobId: string,
    findings: AddFindingInput[],
  ): Promise<Finding[]> {
    if (!this.data.reviewJobs[reviewJobId]) {
      throw new EntityNotFoundError("ReviewJob", reviewJobId);
    }
    const created = findings.map((f): Finding => {
      const finding: Finding = {
        id: this.idGen("fnd"),
        reviewJobId,
        filePath: f.filePath,
        line: f.line,
        endLine: f.endLine,
        severity: f.severity,
        title: f.title,
        detail: f.detail,
        suggestion: f.suggestion,
        category: f.category,
      };
      this.data.findings[finding.id] = finding;
      return finding;
    });
    await this.persist();
    return created;
  }

  async listFindings(reviewJobId: string): Promise<Finding[]> {
    return Object.values(this.data.findings).filter(
      (f) => f.reviewJobId === reviewJobId,
    );
  }

  async getRepoInsight(repoId: string): Promise<RepoInsight | null> {
    return this.data.repoInsights[repoId] ?? null;
  }

  async upsertRepoInsight(input: UpsertRepoInsightInput): Promise<RepoInsight> {
    const insight: RepoInsight = {
      repoId: input.repoId,
      summary: input.summary,
      headSha: input.headSha,
      updatedAt: this.clock(),
    };
    this.data.repoInsights[input.repoId] = insight;
    await this.persist();
    return insight;
  }

  async close(): Promise<void> {
    await this.persist();
  }
}
