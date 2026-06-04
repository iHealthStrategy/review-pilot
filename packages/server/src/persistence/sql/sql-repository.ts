import type {
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
} from "../../domain/entities.js";
import { assertTransition } from "../../domain/state-machine.js";
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

  async close(): Promise<void> {
    await this.client.close();
  }
}
