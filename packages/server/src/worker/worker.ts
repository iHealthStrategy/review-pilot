import type { Finding, Platform, Severity } from "../domain/entities.js";
import { EntityNotFoundError, type Repository } from "../persistence/repository.js";
import type { GitProvider } from "../providers/git-provider.js";
import { buildCheckRun } from "../review/check-run.js";
import type { ReviewService } from "../review/review-service.js";
import { deliverSummaryComment, formatFindingsComment } from "./comment-format.js";

export interface WorkerOptions {
  /** Also post line-level comments for findings that have a line + provider support. */
  inlineComments?: boolean;
  /** Max jobs processed concurrently by {@link Worker.runPending}. */
  concurrency?: number;
  /** Publish a Check Run (with inline annotations) when the provider supports it. */
  publishCheckRun?: boolean;
  /** Gate threshold: the Check Run concludes failure at this severity or worse. */
  failOnSeverity?: Severity;
}

export type JobOutcome =
  | { jobId: string; status: "succeeded"; findings: number; commentId: string }
  | { jobId: string; status: "failed"; error: string }
  | { jobId: string; status: "skipped"; reason: string };

/**
 * Executes ReviewJobs end-to-end and delivers results on two channels:
 * persisted findings (for the Web UI) and a PR/MR comment (write-back). Drives
 * the job state machine pending→running→succeeded/failed and records progress
 * and logs throughout.
 */
export class Worker {
  constructor(
    private readonly repo: Repository,
    private readonly reviewService: ReviewService,
    private readonly providerFor: (platform: Platform) => GitProvider,
    private readonly options: WorkerOptions = {},
  ) {}

  /**
   * Run one job through the full pipeline. Transitions it `pending`→`running`
   * itself (the retry path). Never throws; returns the outcome.
   */
  async runJob(jobId: string): Promise<JobOutcome> {
    const job = await this.repo.getReviewJob(jobId);
    if (!job) throw new EntityNotFoundError("ReviewJob", jobId);
    if (job.status !== "pending") {
      return { jobId, status: "skipped", reason: `job is ${job.status}, not pending` };
    }
    await this.repo.transitionReviewJob(jobId, "running", { progress: 5 });
    return this.execute(jobId);
  }

  /**
   * Execute a job that is ALREADY in `running` (e.g. just claimed). Syncs the
   * repo, runs the engine, persists findings and writes back a PR comment,
   * driving the job to a terminal state. Never throws; returns the outcome.
   */
  private async execute(jobId: string): Promise<JobOutcome> {
    await this.repo.appendJobLog(jobId, "review started");
    try {
      const job = await this.repo.getReviewJob(jobId);
      if (!job) throw new EntityNotFoundError("ReviewJob", jobId);
      const pr = await this.repo.getPullRequest(job.pullRequestId);
      if (!pr) throw new EntityNotFoundError("PullRequest", job.pullRequestId);
      const repo = await this.repo.getRepo(pr.repoId);
      if (!repo) throw new EntityNotFoundError("Repo", pr.repoId);

      await this.repo.appendJobLog(jobId, "syncing repository and running engine");
      await this.repo.setReviewJobProgress(jobId, 40);
      const { findings } = await this.reviewService.review(jobId);
      await this.repo.appendJobLog(jobId, `engine produced ${findings.length} finding(s)`);
      await this.repo.setReviewJobProgress(jobId, 80);

      const provider = this.providerFor(repo.platform);
      const body = formatFindingsComment(findings, {
        engine: job.engine,
        prNumber: pr.number,
      });
      const comment = await deliverSummaryComment(
        provider,
        { fullName: repo.fullName },
        pr.number,
        body,
      );
      await this.repo.appendJobLog(jobId, `delivered summary comment ${comment.id}`);

      if (this.options.publishCheckRun && provider.createCheckRun) {
        const { checkRun, conclusion } = buildCheckRun(findings, {
          name: "ReviewPilot",
          headSha: pr.headSha,
          summary: body,
          ...(this.options.failOnSeverity ? { threshold: this.options.failOnSeverity } : {}),
        });
        const check = await provider.createCheckRun({ fullName: repo.fullName }, checkRun);
        await this.repo.appendJobLog(jobId, `published check run ${check.id} (${conclusion})`);
      }

      if (this.options.inlineComments && provider.postInlineComment) {
        await this.postInline(provider, repo.fullName, pr.number, pr.headSha, findings, jobId);
      }

      await this.repo.setReviewJobProgress(jobId, 100);
      await this.repo.transitionReviewJob(jobId, "succeeded", { progress: 100 });
      return { jobId, status: "succeeded", findings: findings.length, commentId: comment.id };
    } catch (err) {
      const message = (err as Error).message;
      await this.repo.appendJobLog(jobId, `failed: ${message}`);
      await this.repo.transitionReviewJob(jobId, "failed", { error: message });
      return { jobId, status: "failed", error: message };
    }
  }

  /** Requeue a failed job and run it again. */
  async retry(jobId: string): Promise<JobOutcome> {
    await this.repo.transitionReviewJob(jobId, "pending");
    return this.runJob(jobId);
  }

  /**
   * Drain the queue by ATOMICALLY claiming pending jobs (so competing stateless
   * workers never double-process one) and executing them with bounded
   * concurrency. Each lane claims-then-executes until the queue is empty.
   */
  async runPending(): Promise<JobOutcome[]> {
    const concurrency = Math.max(1, this.options.concurrency ?? 1);
    const outcomes: JobOutcome[] = [];
    const lane = async (): Promise<void> => {
      for (;;) {
        const job = await this.repo.claimNextPendingJob();
        if (!job) return;
        outcomes.push(await this.execute(job.id));
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => lane()));
    return outcomes;
  }

  /**
   * Requeue jobs stranded in `running` by a crashed/redeployed worker so a
   * restarted stateless container resumes them. Marks each failed (recoverable)
   * then back to pending. Returns the number recovered. Assumes a single active
   * worker — do not enable alongside other live workers.
   */
  async recoverInterrupted(): Promise<number> {
    const running = await this.repo.listReviewJobs({ status: "running" });
    for (const job of running) {
      await this.repo.appendJobLog(job.id, "interrupted: recovered on startup, requeued");
      await this.repo.transitionReviewJob(job.id, "failed", {
        error: "worker interrupted before completion (recovered on startup)",
      });
      await this.repo.transitionReviewJob(job.id, "pending");
    }
    return running.length;
  }

  private async postInline(
    provider: GitProvider,
    fullName: string,
    prNumber: number,
    headSha: string,
    findings: Finding[],
    jobId: string,
  ): Promise<void> {
    if (!provider.postInlineComment) return;
    let posted = 0;
    for (const f of findings) {
      if (f.line === undefined) continue;
      await provider.postInlineComment(
        { fullName },
        prNumber,
        {
          path: f.filePath,
          line: f.line,
          commitSha: headSha,
          body: `**${f.title}**\n\n${f.detail}${f.suggestion ? `\n\n💡 ${f.suggestion}` : ""}`,
        },
      );
      posted += 1;
    }
    await this.repo.appendJobLog(jobId, `posted ${posted} inline comment(s)`);
  }
}
