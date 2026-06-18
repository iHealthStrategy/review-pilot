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
  Severity,
  User,
  UserRole,
} from "../../domain/entities.js";
import { assertTransition } from "../../domain/state-machine.js";
import {
  type AddFindingInput,
  type Clock,
  type CreateApiTokenInput,
  type CreateProjectInput,
  type CreateRepoInput,
  type CreateReviewJobInput,
  type CreateUserInput,
  EntityNotFoundError,
  type IdGen,
  type Repository,
  type ReviewJobFilter,
  type ReviewJobPatch,
  type UpsertPullRequestInput,
  type UpsertRepoInsightInput,
  systemClock,
  uuidIdGen,
} from "../repository.js";
import type { MongoCollection, MongoDoc, MongoStore } from "./mongo-store.js";

const COLLECTIONS = {
  projects: "projects",
  repos: "repos",
  pullRequests: "pull_requests",
  reviewJobs: "review_jobs",
  findings: "findings",
  repoInsights: "repo_insights",
  users: "users",
  apiTokens: "api_tokens",
} as const;

/** Drop `undefined` values so optional fields round-trip as absent, not null. */
function clean(doc: MongoDoc): MongoDoc {
  const out: MongoDoc = {};
  for (const [k, v] of Object.entries(doc)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function toProject(d: MongoDoc): Project {
  return {
    id: d.id as string,
    name: d.name as string,
    platform: d.platform as Platform,
    defaultEngine: d.defaultEngine as ReviewEngineKind,
    enabledEngines: (d.enabledEngines as ReviewEngineKind[]) ?? [],
    createdAt: d.createdAt as string,
    updatedAt: d.updatedAt as string,
  };
}
function toRepo(d: MongoDoc): Repo {
  return {
    id: d.id as string,
    projectId: d.projectId as string,
    platform: d.platform as Platform,
    fullName: d.fullName as string,
    remoteUrl: d.remoteUrl as string,
    cloneUrl: d.cloneUrl as string,
    defaultBranch: d.defaultBranch as string,
    createdAt: d.createdAt as string,
  };
}
function toPullRequest(d: MongoDoc): PullRequest {
  return {
    id: d.id as string,
    repoId: d.repoId as string,
    number: d.number as number,
    title: d.title as string,
    sourceBranch: d.sourceBranch as string,
    targetBranch: d.targetBranch as string,
    headSha: d.headSha as string,
    author: d.author as string,
    url: d.url as string,
    state: d.state as PullRequestState,
    createdAt: d.createdAt as string,
  };
}
function toReviewJob(d: MongoDoc): ReviewJob {
  const job: ReviewJob = {
    id: d.id as string,
    pullRequestId: d.pullRequestId as string,
    engine: d.engine as ReviewEngineKind,
    status: d.status as JobStatus,
    attempts: (d.attempts as number) ?? 0,
    progress: (d.progress as number) ?? 0,
    logs: (d.logs as string[]) ?? [],
    createdAt: d.createdAt as string,
  };
  return {
    ...job,
    ...(d.error != null ? { error: d.error as string } : {}),
    ...(d.startedAt != null ? { startedAt: d.startedAt as string } : {}),
    ...(d.finishedAt != null ? { finishedAt: d.finishedAt as string } : {}),
  };
}
function toFinding(d: MongoDoc): Finding {
  const finding: Finding = {
    id: d.id as string,
    reviewJobId: d.reviewJobId as string,
    filePath: d.filePath as string,
    severity: d.severity as Severity,
    title: d.title as string,
    detail: d.detail as string,
  };
  return {
    ...finding,
    ...(d.line != null ? { line: d.line as number } : {}),
    ...(d.endLine != null ? { endLine: d.endLine as number } : {}),
    ...(d.suggestion != null ? { suggestion: d.suggestion as string } : {}),
    ...(d.category != null ? { category: d.category as string } : {}),
  };
}

function toRepoInsight(d: MongoDoc): RepoInsight {
  return {
    repoId: d.repoId as string,
    summary: d.summary as string,
    headSha: d.headSha as string,
    updatedAt: d.updatedAt as string,
  };
}

function toUser(d: MongoDoc): User {
  return {
    id: d.id as string,
    email: d.email as string,
    passwordHash: d.passwordHash as string,
    role: d.role as UserRole,
    createdAt: d.createdAt as string,
    updatedAt: d.updatedAt as string,
  };
}
function toApiToken(d: MongoDoc): ApiToken {
  const token: ApiToken = {
    id: d.id as string,
    userId: d.userId as string,
    name: d.name as string,
    tokenHash: d.tokenHash as string,
    prefix: d.prefix as string,
    createdAt: d.createdAt as string,
  };
  return {
    ...token,
    ...(d.lastUsedAt != null ? { lastUsedAt: d.lastUsedAt as string } : {}),
  };
}

export interface MongoRepositoryOptions {
  clock?: Clock;
  idGen?: IdGen;
}

/**
 * MongoDB-backed {@link Repository}. State lives entirely in Mongo so the
 * service container is stateless and horizontally scalable. Documents are
 * stored in their plain entity shape (camelCase); the `id` field is the
 * application key (a unique index), independent of Mongo's `_id`.
 *
 * Built on the {@link MongoStore} port so the full contract is verified against
 * an in-memory fake with no running database, mirroring how the SQL backend is
 * verified against PGlite.
 */
export class MongoRepository implements Repository {
  private readonly clock: Clock;
  private readonly idGen: IdGen;

  constructor(
    private readonly store: MongoStore,
    options: MongoRepositoryOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.idGen = options.idGen ?? uuidIdGen;
  }

  private col(name: string): MongoCollection {
    return this.store.collection(name);
  }

  async init(): Promise<void> {
    await this.col(COLLECTIONS.projects).createIndex({ id: 1 }, { unique: true });
    await this.col(COLLECTIONS.repos).createIndex({ id: 1 }, { unique: true });
    await this.col(COLLECTIONS.repos).createIndex({ platform: 1, fullName: 1 });
    await this.col(COLLECTIONS.pullRequests).createIndex({ id: 1 }, { unique: true });
    await this.col(COLLECTIONS.pullRequests).createIndex({ repoId: 1, number: 1 });
    await this.col(COLLECTIONS.reviewJobs).createIndex({ id: 1 }, { unique: true });
    await this.col(COLLECTIONS.reviewJobs).createIndex({ status: 1, createdAt: 1 });
    await this.col(COLLECTIONS.reviewJobs).createIndex({ pullRequestId: 1 });
    await this.col(COLLECTIONS.findings).createIndex({ reviewJobId: 1 });
    await this.col(COLLECTIONS.repoInsights).createIndex({ repoId: 1 }, { unique: true });
    await this.col(COLLECTIONS.users).createIndex({ id: 1 }, { unique: true });
    await this.col(COLLECTIONS.users).createIndex({ email: 1 }, { unique: true });
    await this.col(COLLECTIONS.apiTokens).createIndex({ id: 1 }, { unique: true });
    await this.col(COLLECTIONS.apiTokens).createIndex({ tokenHash: 1 }, { unique: true });
    await this.col(COLLECTIONS.apiTokens).createIndex({ userId: 1 });
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
    await this.col(COLLECTIONS.projects).insertOne({ ...project });
    return project;
  }

  async getProject(id: string): Promise<Project | null> {
    const d = await this.col(COLLECTIONS.projects).findOne({ id });
    return d ? toProject(d) : null;
  }

  async listProjects(): Promise<Project[]> {
    const docs = await this.col(COLLECTIONS.projects).find(
      {},
      { sort: { field: "createdAt", dir: 1 } },
    );
    return docs.map(toProject);
  }

  async createRepo(input: CreateRepoInput): Promise<Repo> {
    if (!(await this.getProject(input.projectId))) {
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
    await this.col(COLLECTIONS.repos).insertOne({ ...repo });
    return repo;
  }

  async getRepo(id: string): Promise<Repo | null> {
    const d = await this.col(COLLECTIONS.repos).findOne({ id });
    return d ? toRepo(d) : null;
  }

  async listReposByProject(projectId: string): Promise<Repo[]> {
    const docs = await this.col(COLLECTIONS.repos).find(
      { projectId },
      { sort: { field: "createdAt", dir: 1 } },
    );
    return docs.map(toRepo);
  }

  async listRepos(): Promise<Repo[]> {
    const docs = await this.col(COLLECTIONS.repos).find(
      {},
      { sort: { field: "createdAt", dir: 1 } },
    );
    return docs.map(toRepo);
  }

  async findRepoByFullName(
    platform: Platform,
    fullName: string,
  ): Promise<Repo | null> {
    const d = await this.col(COLLECTIONS.repos).findOne({ platform, fullName });
    return d ? toRepo(d) : null;
  }

  async upsertPullRequest(input: UpsertPullRequestInput): Promise<PullRequest> {
    const existing = await this.findPullRequest(input.repoId, input.number);
    if (existing) {
      const updated: PullRequest = { ...existing, ...input };
      await this.col(COLLECTIONS.pullRequests).updateOne(
        { id: existing.id },
        {
          $set: {
            title: updated.title,
            sourceBranch: updated.sourceBranch,
            targetBranch: updated.targetBranch,
            headSha: updated.headSha,
            author: updated.author,
            url: updated.url,
            state: updated.state,
          },
        },
      );
      return updated;
    }
    if (!(await this.getRepo(input.repoId))) {
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
    await this.col(COLLECTIONS.pullRequests).insertOne({ ...pr });
    return pr;
  }

  async getPullRequest(id: string): Promise<PullRequest | null> {
    const d = await this.col(COLLECTIONS.pullRequests).findOne({ id });
    return d ? toPullRequest(d) : null;
  }

  async findPullRequest(
    repoId: string,
    number: number,
  ): Promise<PullRequest | null> {
    const d = await this.col(COLLECTIONS.pullRequests).findOne({ repoId, number });
    return d ? toPullRequest(d) : null;
  }

  async createReviewJob(input: CreateReviewJobInput): Promise<ReviewJob> {
    if (!(await this.getPullRequest(input.pullRequestId))) {
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
    await this.col(COLLECTIONS.reviewJobs).insertOne({ ...job });
    return job;
  }

  async getReviewJob(id: string): Promise<ReviewJob | null> {
    const d = await this.col(COLLECTIONS.reviewJobs).findOne({ id });
    return d ? toReviewJob(d) : null;
  }

  async listReviewJobs(filter: ReviewJobFilter = {}): Promise<ReviewJob[]> {
    const mongoFilter: MongoDoc = {};
    if (filter.status) mongoFilter.status = filter.status;
    if (filter.pullRequestId) mongoFilter.pullRequestId = filter.pullRequestId;
    const docs = await this.col(COLLECTIONS.reviewJobs).find(
      mongoFilter as Record<string, string>,
      { sort: { field: "createdAt", dir: 1 } },
    );
    return docs.map(toReviewJob);
  }

  async transitionReviewJob(
    id: string,
    to: JobStatus,
    patch: ReviewJobPatch = {},
  ): Promise<ReviewJob> {
    const job = await this.getReviewJob(id);
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
      finishedAt: to === "succeeded" || to === "failed" ? now : job.finishedAt,
    };
    await this.col(COLLECTIONS.reviewJobs).updateOne(
      { id },
      {
        $set: clean({
          status: next.status,
          attempts: next.attempts,
          progress: next.progress,
          error: next.error ?? null,
          startedAt: next.startedAt ?? null,
          finishedAt: next.finishedAt ?? null,
        }),
      },
    );
    return next;
  }

  async claimNextPendingJob(): Promise<ReviewJob | null> {
    const now = this.clock();
    const claimed = await this.col(COLLECTIONS.reviewJobs).findOneAndUpdate(
      { status: "pending" },
      {
        $set: { status: "running", startedAt: now },
        $inc: { attempts: 1 },
      },
      { sort: { field: "createdAt", dir: 1 } },
    );
    return claimed ? toReviewJob(claimed) : null;
  }

  async appendJobLog(id: string, line: string): Promise<void> {
    const res = await this.col(COLLECTIONS.reviewJobs).updateOne(
      { id },
      { $push: { logs: line } },
    );
    if (res.matched === 0) throw new EntityNotFoundError("ReviewJob", id);
  }

  async setReviewJobProgress(id: string, progress: number): Promise<ReviewJob> {
    const job = await this.getReviewJob(id);
    if (!job) throw new EntityNotFoundError("ReviewJob", id);
    const clamped = Math.max(0, Math.min(100, progress));
    await this.col(COLLECTIONS.reviewJobs).updateOne(
      { id },
      { $set: { progress: clamped } },
    );
    return { ...job, progress: clamped };
  }

  async addFindings(
    reviewJobId: string,
    findings: AddFindingInput[],
  ): Promise<Finding[]> {
    if (!(await this.getReviewJob(reviewJobId))) {
      throw new EntityNotFoundError("ReviewJob", reviewJobId);
    }
    const created = findings.map(
      (f): Finding => ({
        id: this.idGen("fnd"),
        reviewJobId,
        filePath: f.filePath,
        ...(f.line !== undefined ? { line: f.line } : {}),
        ...(f.endLine !== undefined ? { endLine: f.endLine } : {}),
        severity: f.severity,
        title: f.title,
        detail: f.detail,
        ...(f.suggestion !== undefined ? { suggestion: f.suggestion } : {}),
        ...(f.category !== undefined ? { category: f.category } : {}),
      }),
    );
    if (created.length > 0) {
      await this.col(COLLECTIONS.findings).insertMany(
        created.map((f) => ({ ...f })),
      );
    }
    return created;
  }

  async listFindings(reviewJobId: string): Promise<Finding[]> {
    const docs = await this.col(COLLECTIONS.findings).find({ reviewJobId });
    return docs.map(toFinding);
  }

  async getRepoInsight(repoId: string): Promise<RepoInsight | null> {
    const d = await this.col(COLLECTIONS.repoInsights).findOne({ repoId });
    return d ? toRepoInsight(d) : null;
  }

  async upsertRepoInsight(input: UpsertRepoInsightInput): Promise<RepoInsight> {
    const insight: RepoInsight = {
      repoId: input.repoId,
      summary: input.summary,
      headSha: input.headSha,
      updatedAt: this.clock(),
    };
    const col = this.col(COLLECTIONS.repoInsights);
    const res = await col.updateOne({ repoId: input.repoId }, { $set: { ...insight } });
    if (res.matched === 0) await col.insertOne({ ...insight });
    return insight;
  }

  async createUser(input: CreateUserInput): Promise<User> {
    const now = this.clock();
    const user: User = {
      id: this.idGen("usr"),
      email: input.email,
      passwordHash: input.passwordHash,
      role: input.role,
      createdAt: now,
      updatedAt: now,
    };
    await this.col(COLLECTIONS.users).insertOne({ ...user });
    return user;
  }

  async getUserById(id: string): Promise<User | null> {
    const d = await this.col(COLLECTIONS.users).findOne({ id });
    return d ? toUser(d) : null;
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const d = await this.col(COLLECTIONS.users).findOne({ email });
    return d ? toUser(d) : null;
  }

  async listUsers(): Promise<User[]> {
    const docs = await this.col(COLLECTIONS.users).find(
      {},
      { sort: { field: "createdAt", dir: 1 } },
    );
    return docs.map(toUser);
  }

  async countUsers(): Promise<number> {
    const docs = await this.col(COLLECTIONS.users).find({});
    return docs.length;
  }

  async updateUserRole(id: string, role: UserRole): Promise<User> {
    const user = await this.getUserById(id);
    if (!user) throw new EntityNotFoundError("User", id);
    const updatedAt = this.clock();
    await this.col(COLLECTIONS.users).updateOne({ id }, { $set: { role, updatedAt } });
    return { ...user, role, updatedAt };
  }

  async createApiToken(input: CreateApiTokenInput): Promise<ApiToken> {
    const token: ApiToken = {
      id: this.idGen("tok"),
      userId: input.userId,
      name: input.name,
      tokenHash: input.tokenHash,
      prefix: input.prefix,
      createdAt: this.clock(),
    };
    await this.col(COLLECTIONS.apiTokens).insertOne({ ...token });
    return token;
  }

  async listApiTokensByUser(userId: string): Promise<ApiToken[]> {
    const docs = await this.col(COLLECTIONS.apiTokens).find(
      { userId },
      { sort: { field: "createdAt", dir: 1 } },
    );
    return docs.map(toApiToken);
  }

  async getApiTokenByHash(tokenHash: string): Promise<ApiToken | null> {
    const d = await this.col(COLLECTIONS.apiTokens).findOne({ tokenHash });
    return d ? toApiToken(d) : null;
  }

  async deleteApiToken(id: string, userId: string): Promise<void> {
    await this.col(COLLECTIONS.apiTokens).deleteOne({ id, userId });
  }

  async touchApiToken(id: string, at: string): Promise<void> {
    await this.col(COLLECTIONS.apiTokens).updateOne({ id }, { $set: { lastUsedAt: at } });
  }

  async close(): Promise<void> {
    await this.store.close();
  }
}
