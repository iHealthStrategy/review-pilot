import type { AppConfig } from "../config.js";
import type { Finding, Platform } from "../domain/entities.js";
import { EntityNotFoundError, type Repository } from "../persistence/repository.js";
import type { GitProvider } from "../providers/git-provider.js";
import type { Cloner } from "./cloner.js";
import { buildReviewContext } from "./context-builder.js";
import { filterToChangedLines } from "./diff-lines.js";
import { createReviewEngine, selectEngineKind, type ReviewEngineDeps } from "./engine-factory.js";
import { ProjectInsightService } from "./project-insight.js";
import type { ReviewContext } from "./review-engine.js";

export interface ReviewServiceDeps {
  repo: Repository;
  config: AppConfig;
  providerFor: (platform: Platform) => GitProvider;
  cloner: Cloner;
  engineDeps?: ReviewEngineDeps;
  scan?: (dir: string) => Promise<string[]>;
}

/**
 * Runs a review for a job: syncs the full repo, builds the whole-codebase +
 * diff context, runs the configured engine, and persists structured findings.
 * State transitions / progress / PR comment write-back are the worker's job
 * (next milestone); this service is the pure produce-and-persist core.
 */
export class ReviewService {
  constructor(private readonly deps: ReviewServiceDeps) {}

  async review(
    jobId: string,
  ): Promise<{ findings: Finding[]; context: ReviewContext }> {
    const job = await this.deps.repo.getReviewJob(jobId);
    if (!job) throw new EntityNotFoundError("ReviewJob", jobId);
    const pr = await this.deps.repo.getPullRequest(job.pullRequestId);
    if (!pr) throw new EntityNotFoundError("PullRequest", job.pullRequestId);
    const repo = await this.deps.repo.getRepo(pr.repoId);
    if (!repo) throw new EntityNotFoundError("Repo", pr.repoId);
    const project = await this.deps.repo.getProject(repo.projectId);

    const kind = selectEngineKind(this.deps.config, project ?? undefined);
    const provider = this.deps.providerFor(repo.platform);

    const { context, workspace } = await buildReviewContext(
      { provider, cloner: this.deps.cloner, scan: this.deps.scan },
      repo,
      pr,
    );
    try {
      const { engineCommand, engineArgs, agentModel, agentMaxTurns } =
        this.deps.config.review;
      const engine = createReviewEngine(kind, {
        timeoutMs: this.deps.config.worker.engineTimeoutMs,
        ...(engineCommand ? { commands: { [kind]: engineCommand } } : {}),
        ...(engineArgs.length ? { args: { [kind]: engineArgs } } : {}),
        agent: {
          ...(agentModel ? { model: agentModel } : {}),
          maxTurns: agentMaxTurns,
        },
        ...this.deps.engineDeps,
      });

      // Ground the review in cached whole-project understanding (refreshed on a
      // TTL via the engine's agentic exploration). No-op for engines that can't
      // summarise (e.g. mock).
      if (this.deps.config.review.projectInsight) {
        const insights = new ProjectInsightService(this.deps.repo, {
          ttlMs: this.deps.config.review.insightTtlMs,
        });
        context.projectInsight = await insights.ensure(engine, repo, context);
      }

      const drafts = await engine.review(context);
      const scoped = this.deps.config.review.onlyChangedLines
        ? filterToChangedLines(drafts, context.diff)
        : drafts;
      const findings = await this.deps.repo.addFindings(jobId, scoped);
      return { findings, context };
    } finally {
      await this.deps.cloner.cleanup(workspace);
    }
  }
}
