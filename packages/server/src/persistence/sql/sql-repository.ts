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
  TokenUsage,
  UsageSource,
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
  type RecordTokenUsageInput,
  type Repository,
  type ReviewJobFilter,
  type ReviewJobPatch,
  type TokenUsageFilter,
  type UpsertPullRequestInput,
  type UpsertRepoInsightInput,
  systemClock,
  uuidIdGen,
} from "../repository.js";
import { runMigrations } from "./migrations.js";
import {
  type SqlClient,
  placeholder,
  placeholderList,
} from "./sql-client.js";

interface ProjectRow {
  id: string;
  name: string;
  platform: string;
  default_engine: string;
  enabled_engines: string;
  created_at: string;
  updated_at: string;
}
interface RepoRow {
  id: string;
  project_id: string;
  platform: string;
  full_name: string;
  remote_url: string;
  clone_url: string;
  default_branch: string;
  created_at: string;
}
interface PullRequestRow {
  id: string;
  repo_id: string;
  number: number;
  title: string;
  source_branch: string;
  target_branch: string;
  head_sha: string;
  author: string;
  url: string;
  state: string;
  created_at: string;
}
interface ReviewJobRow {
  id: string;
  pull_request_id: string;
  engine: string;
  status: string;
  attempts: number;
  progress: number;
  error: string | null;
  logs: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}
interface FindingRow {
  id: string;
  review_job_id: string;
  file_path: string;
  line: number | null;
  end_line: number | null;
  severity: string;
  title: string;
  detail: string;
  suggestion: string | null;
  category: string | null;
}

function toProject(r: ProjectRow): Project {
  return {
    id: r.id,
    name: r.name,
    platform: r.platform as Platform,
    defaultEngine: r.default_engine as ReviewEngineKind,
    enabledEngines: JSON.parse(r.enabled_engines) as ReviewEngineKind[],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
function toRepo(r: RepoRow): Repo {
  return {
    id: r.id,
    projectId: r.project_id,
    platform: r.platform as Platform,
    fullName: r.full_name,
    remoteUrl: r.remote_url,
    cloneUrl: r.clone_url,
    defaultBranch: r.default_branch,
    createdAt: r.created_at,
  };
}
function toPullRequest(r: PullRequestRow): PullRequest {
  return {
    id: r.id,
    repoId: r.repo_id,
    number: r.number,
    title: r.title,
    sourceBranch: r.source_branch,
    targetBranch: r.target_branch,
    headSha: r.head_sha,
    author: r.author,
    url: r.url,
    state: r.state as PullRequestState,
    createdAt: r.created_at,
  };
}
function toReviewJob(r: ReviewJobRow): ReviewJob {
  return {
    id: r.id,
    pullRequestId: r.pull_request_id,
    engine: r.engine as ReviewEngineKind,
    status: r.status as JobStatus,
    attempts: r.attempts,
    progress: r.progress,
    error: r.error ?? undefined,
    logs: JSON.parse(r.logs) as string[],
    createdAt: r.created_at,
    startedAt: r.started_at ?? undefined,
    finishedAt: r.finished_at ?? undefined,
  };
}
interface RepoInsightRow {
  repo_id: string;
  summary: string;
  head_sha: string;
  updated_at: string;
}
function toRepoInsight(r: RepoInsightRow): RepoInsight {
  return {
    repoId: r.repo_id,
    summary: r.summary,
    headSha: r.head_sha,
    updatedAt: r.updated_at,
  };
}

function toFinding(r: FindingRow): Finding {
  return {
    id: r.id,
    reviewJobId: r.review_job_id,
    filePath: r.file_path,
    line: r.line ?? undefined,
    endLine: r.end_line ?? undefined,
    severity: r.severity as Severity,
    title: r.title,
    detail: r.detail,
    suggestion: r.suggestion ?? undefined,
    category: r.category ?? undefined,
  };
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: string;
  created_at: string;
  updated_at: string;
}
function toUser(r: UserRow): User {
  return {
    id: r.id,
    email: r.email,
    passwordHash: r.password_hash,
    role: r.role as UserRole,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
interface ApiTokenRow {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
}
function toApiToken(r: ApiTokenRow): ApiToken {
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    tokenHash: r.token_hash,
    prefix: r.prefix,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at ?? undefined,
  };
}
interface TokenUsageRow {
  id: string;
  source: string;
  source_id: string;
  source_label: string;
  engine: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  estimated: number;
  at: string;
}
function toTokenUsage(r: TokenUsageRow): TokenUsage {
  return {
    id: r.id,
    source: r.source as UsageSource,
    sourceId: r.source_id,
    sourceLabel: r.source_label,
    engine: r.engine as ReviewEngineKind,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    totalTokens: r.total_tokens,
    estimated: !!r.estimated,
    at: r.at,
  };
}

export interface SqlRepositoryOptions {
  clock?: Clock;
  idGen?: IdGen;
}

/**
 * Repository implementation over the {@link SqlClient} port. Dialect-aware via
 * positional placeholders; identical behaviour to the memory/file backends
 * (verified by the shared contract test when a live client is available).
 */
export class SqlRepository implements Repository {
  private readonly clock: Clock;
  private readonly idGen: IdGen;

  constructor(
    private readonly client: SqlClient,
    options: SqlRepositoryOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.idGen = options.idGen ?? uuidIdGen;
  }

  private ph(index: number): string {
    return placeholder(this.client.dialect, index);
  }

  async init(): Promise<void> {
    await runMigrations(this.client);
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
    await this.client.run(
      `INSERT INTO projects
         (id, name, platform, default_engine, enabled_engines, created_at, updated_at)
       VALUES (${placeholderList(this.client.dialect, 7)})`,
      [
        project.id,
        project.name,
        project.platform,
        project.defaultEngine,
        JSON.stringify(project.enabledEngines),
        project.createdAt,
        project.updatedAt,
      ],
    );
    return project;
  }

  async getProject(id: string): Promise<Project | null> {
    const row = await this.client.get<ProjectRow>(
      `SELECT * FROM projects WHERE id = ${this.ph(1)}`,
      [id],
    );
    return row ? toProject(row) : null;
  }

  async listProjects(): Promise<Project[]> {
    const rows = await this.client.all<ProjectRow>(
      "SELECT * FROM projects ORDER BY created_at",
    );
    return rows.map(toProject);
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
    await this.client.run(
      `INSERT INTO repos
         (id, project_id, platform, full_name, remote_url, clone_url, default_branch, created_at)
       VALUES (${placeholderList(this.client.dialect, 8)})`,
      [
        repo.id,
        repo.projectId,
        repo.platform,
        repo.fullName,
        repo.remoteUrl,
        repo.cloneUrl,
        repo.defaultBranch,
        repo.createdAt,
      ],
    );
    return repo;
  }

  async getRepo(id: string): Promise<Repo | null> {
    const row = await this.client.get<RepoRow>(
      `SELECT * FROM repos WHERE id = ${this.ph(1)}`,
      [id],
    );
    return row ? toRepo(row) : null;
  }

  async listReposByProject(projectId: string): Promise<Repo[]> {
    const rows = await this.client.all<RepoRow>(
      `SELECT * FROM repos WHERE project_id = ${this.ph(1)} ORDER BY created_at`,
      [projectId],
    );
    return rows.map(toRepo);
  }

  async listRepos(): Promise<Repo[]> {
    const rows = await this.client.all<RepoRow>(
      "SELECT * FROM repos ORDER BY created_at",
    );
    return rows.map(toRepo);
  }

  async findRepoByFullName(
    platform: Platform,
    fullName: string,
  ): Promise<Repo | null> {
    const row = await this.client.get<RepoRow>(
      `SELECT * FROM repos WHERE platform = ${this.ph(1)} AND full_name = ${this.ph(2)}`,
      [platform, fullName],
    );
    return row ? toRepo(row) : null;
  }

  async upsertPullRequest(
    input: UpsertPullRequestInput,
  ): Promise<PullRequest> {
    const existing = await this.findPullRequest(input.repoId, input.number);
    if (existing) {
      await this.client.run(
        `UPDATE pull_requests SET
           title = ${this.ph(1)}, source_branch = ${this.ph(2)},
           target_branch = ${this.ph(3)}, head_sha = ${this.ph(4)},
           author = ${this.ph(5)}, url = ${this.ph(6)}, state = ${this.ph(7)}
         WHERE id = ${this.ph(8)}`,
        [
          input.title,
          input.sourceBranch,
          input.targetBranch,
          input.headSha,
          input.author,
          input.url,
          input.state,
          existing.id,
        ],
      );
      return { ...existing, ...input };
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
    await this.client.run(
      `INSERT INTO pull_requests
         (id, repo_id, number, title, source_branch, target_branch, head_sha,
          author, url, state, created_at)
       VALUES (${placeholderList(this.client.dialect, 11)})`,
      [
        pr.id,
        pr.repoId,
        pr.number,
        pr.title,
        pr.sourceBranch,
        pr.targetBranch,
        pr.headSha,
        pr.author,
        pr.url,
        pr.state,
        pr.createdAt,
      ],
    );
    return pr;
  }

  async getPullRequest(id: string): Promise<PullRequest | null> {
    const row = await this.client.get<PullRequestRow>(
      `SELECT * FROM pull_requests WHERE id = ${this.ph(1)}`,
      [id],
    );
    return row ? toPullRequest(row) : null;
  }

  async findPullRequest(
    repoId: string,
    number: number,
  ): Promise<PullRequest | null> {
    const row = await this.client.get<PullRequestRow>(
      `SELECT * FROM pull_requests WHERE repo_id = ${this.ph(1)} AND number = ${this.ph(2)}`,
      [repoId, number],
    );
    return row ? toPullRequest(row) : null;
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
    await this.client.run(
      `INSERT INTO review_jobs
         (id, pull_request_id, engine, status, attempts, progress, error, logs,
          created_at, started_at, finished_at)
       VALUES (${placeholderList(this.client.dialect, 11)})`,
      [
        job.id,
        job.pullRequestId,
        job.engine,
        job.status,
        job.attempts,
        job.progress,
        null,
        JSON.stringify(job.logs),
        job.createdAt,
        null,
        null,
      ],
    );
    return job;
  }

  async getReviewJob(id: string): Promise<ReviewJob | null> {
    const row = await this.client.get<ReviewJobRow>(
      `SELECT * FROM review_jobs WHERE id = ${this.ph(1)}`,
      [id],
    );
    return row ? toReviewJob(row) : null;
  }

  async listReviewJobs(filter: ReviewJobFilter = {}): Promise<ReviewJob[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.status) {
      params.push(filter.status);
      clauses.push(`status = ${this.ph(params.length)}`);
    }
    if (filter.pullRequestId) {
      params.push(filter.pullRequestId);
      clauses.push(`pull_request_id = ${this.ph(params.length)}`);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = await this.client.all<ReviewJobRow>(
      `SELECT * FROM review_jobs${where} ORDER BY created_at`,
      params,
    );
    return rows.map(toReviewJob);
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
      finishedAt:
        to === "succeeded" || to === "failed" ? now : job.finishedAt,
    };
    await this.client.run(
      `UPDATE review_jobs SET
         status = ${this.ph(1)}, attempts = ${this.ph(2)}, progress = ${this.ph(3)},
         error = ${this.ph(4)}, started_at = ${this.ph(5)}, finished_at = ${this.ph(6)}
       WHERE id = ${this.ph(7)}`,
      [
        next.status,
        next.attempts,
        next.progress,
        next.error ?? null,
        next.startedAt ?? null,
        next.finishedAt ?? null,
        id,
      ],
    );
    return next;
  }

  async claimNextPendingJob(): Promise<ReviewJob | null> {
    const row = await this.client.get<{ id: string }>(
      `SELECT id FROM review_jobs WHERE status = ${this.ph(1)}
       ORDER BY created_at LIMIT 1`,
      ["pending"],
    );
    if (!row) return null;
    return this.transitionReviewJob(row.id, "running");
  }

  async appendJobLog(id: string, line: string): Promise<void> {
    const job = await this.getReviewJob(id);
    if (!job) throw new EntityNotFoundError("ReviewJob", id);
    const logs = [...job.logs, line];
    await this.client.run(
      `UPDATE review_jobs SET logs = ${this.ph(1)} WHERE id = ${this.ph(2)}`,
      [JSON.stringify(logs), id],
    );
  }

  async setReviewJobProgress(id: string, progress: number): Promise<ReviewJob> {
    const job = await this.getReviewJob(id);
    if (!job) throw new EntityNotFoundError("ReviewJob", id);
    const clamped = Math.max(0, Math.min(100, progress));
    await this.client.run(
      `UPDATE review_jobs SET progress = ${this.ph(1)} WHERE id = ${this.ph(2)}`,
      [clamped, id],
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
    const created: Finding[] = [];
    for (const f of findings) {
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
      await this.client.run(
        `INSERT INTO findings
           (id, review_job_id, file_path, line, end_line, severity, title,
            detail, suggestion, category)
         VALUES (${placeholderList(this.client.dialect, 10)})`,
        [
          finding.id,
          finding.reviewJobId,
          finding.filePath,
          finding.line ?? null,
          finding.endLine ?? null,
          finding.severity,
          finding.title,
          finding.detail,
          finding.suggestion ?? null,
          finding.category ?? null,
        ],
      );
      created.push(finding);
    }
    return created;
  }

  async listFindings(reviewJobId: string): Promise<Finding[]> {
    const rows = await this.client.all<FindingRow>(
      `SELECT * FROM findings WHERE review_job_id = ${this.ph(1)}`,
      [reviewJobId],
    );
    return rows.map(toFinding);
  }

  async getRepoInsight(repoId: string): Promise<RepoInsight | null> {
    const row = await this.client.get<RepoInsightRow>(
      `SELECT * FROM repo_insights WHERE repo_id = ${this.ph(1)}`,
      [repoId],
    );
    return row ? toRepoInsight(row) : null;
  }

  async upsertRepoInsight(input: UpsertRepoInsightInput): Promise<RepoInsight> {
    const insight: RepoInsight = {
      repoId: input.repoId,
      summary: input.summary,
      headSha: input.headSha,
      updatedAt: this.clock(),
    };
    const existing = await this.getRepoInsight(input.repoId);
    if (existing) {
      await this.client.run(
        `UPDATE repo_insights SET summary = ${this.ph(1)}, head_sha = ${this.ph(2)},
           updated_at = ${this.ph(3)} WHERE repo_id = ${this.ph(4)}`,
        [insight.summary, insight.headSha, insight.updatedAt, insight.repoId],
      );
    } else {
      await this.client.run(
        `INSERT INTO repo_insights (repo_id, summary, head_sha, updated_at)
         VALUES (${placeholderList(this.client.dialect, 4)})`,
        [insight.repoId, insight.summary, insight.headSha, insight.updatedAt],
      );
    }
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
    await this.client.run(
      `INSERT INTO users (id, email, password_hash, role, created_at, updated_at)
       VALUES (${placeholderList(this.client.dialect, 6)})`,
      [user.id, user.email, user.passwordHash, user.role, user.createdAt, user.updatedAt],
    );
    return user;
  }

  async getUserById(id: string): Promise<User | null> {
    const row = await this.client.get<UserRow>(
      `SELECT * FROM users WHERE id = ${this.ph(1)}`,
      [id],
    );
    return row ? toUser(row) : null;
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const row = await this.client.get<UserRow>(
      `SELECT * FROM users WHERE email = ${this.ph(1)}`,
      [email],
    );
    return row ? toUser(row) : null;
  }

  async listUsers(): Promise<User[]> {
    const rows = await this.client.all<UserRow>(
      "SELECT * FROM users ORDER BY created_at",
    );
    return rows.map(toUser);
  }

  async countUsers(): Promise<number> {
    const row = await this.client.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM users",
    );
    return Number(row?.n ?? 0);
  }

  async updateUserRole(id: string, role: UserRole): Promise<User> {
    const user = await this.getUserById(id);
    if (!user) throw new EntityNotFoundError("User", id);
    const updatedAt = this.clock();
    await this.client.run(
      `UPDATE users SET role = ${this.ph(1)}, updated_at = ${this.ph(2)} WHERE id = ${this.ph(3)}`,
      [role, updatedAt, id],
    );
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
    await this.client.run(
      `INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, created_at, last_used_at)
       VALUES (${placeholderList(this.client.dialect, 7)})`,
      [token.id, token.userId, token.name, token.tokenHash, token.prefix, token.createdAt, null],
    );
    return token;
  }

  async listApiTokensByUser(userId: string): Promise<ApiToken[]> {
    const rows = await this.client.all<ApiTokenRow>(
      `SELECT * FROM api_tokens WHERE user_id = ${this.ph(1)} ORDER BY created_at`,
      [userId],
    );
    return rows.map(toApiToken);
  }

  async getApiTokenByHash(tokenHash: string): Promise<ApiToken | null> {
    const row = await this.client.get<ApiTokenRow>(
      `SELECT * FROM api_tokens WHERE token_hash = ${this.ph(1)}`,
      [tokenHash],
    );
    return row ? toApiToken(row) : null;
  }

  async deleteApiToken(id: string, userId: string): Promise<void> {
    await this.client.run(
      `DELETE FROM api_tokens WHERE id = ${this.ph(1)} AND user_id = ${this.ph(2)}`,
      [id, userId],
    );
  }

  async touchApiToken(id: string, at: string): Promise<void> {
    await this.client.run(
      `UPDATE api_tokens SET last_used_at = ${this.ph(1)} WHERE id = ${this.ph(2)}`,
      [at, id],
    );
  }

  async recordTokenUsage(input: RecordTokenUsageInput): Promise<TokenUsage> {
    const usage: TokenUsage = {
      id: this.idGen("use"),
      source: input.source,
      sourceId: input.sourceId,
      sourceLabel: input.sourceLabel,
      engine: input.engine,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      totalTokens: input.inputTokens + input.outputTokens,
      estimated: input.estimated,
      at: input.at ?? this.clock(),
    };
    await this.client.run(
      `INSERT INTO token_usage
         (id, source, source_id, source_label, engine, input_tokens, output_tokens, total_tokens, estimated, at)
       VALUES (${placeholderList(this.client.dialect, 10)})`,
      [
        usage.id,
        usage.source,
        usage.sourceId,
        usage.sourceLabel,
        usage.engine,
        usage.inputTokens,
        usage.outputTokens,
        usage.totalTokens,
        usage.estimated ? 1 : 0,
        usage.at,
      ],
    );
    return usage;
  }

  async listTokenUsage(filter: TokenUsageFilter = {}): Promise<TokenUsage[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.source) {
      params.push(filter.source);
      clauses.push(`source = ${this.ph(params.length)}`);
    }
    if (filter.sourceId) {
      params.push(filter.sourceId);
      clauses.push(`source_id = ${this.ph(params.length)}`);
    }
    if (filter.since) {
      params.push(filter.since);
      clauses.push(`at >= ${this.ph(params.length)}`);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = await this.client.all<TokenUsageRow>(
      `SELECT * FROM token_usage${where} ORDER BY at DESC`,
      params,
    );
    return rows.map(toTokenUsage);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
