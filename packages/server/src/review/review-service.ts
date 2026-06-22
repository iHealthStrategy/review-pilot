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
import { GraphCacheService } from "./graph-cache.js";
import { ensureStructuralContext } from "./structural-review.js";

export interface ReviewServiceDeps {
  repo: Repository;
  config: AppConfig;
  providerFor: (platform: Platform) => GitProvider;
  cloner: Cloner;
  engineDeps?: ReviewEngineDeps;
  scan?: (dir: string) => Promise<string[]>;
  /** Shared base-graph cache for structural context (constructed from config if omitted). */
  graphCache?: GraphCacheService;
}

/**
 * Runs a review for a job: syncs the full repo, builds the whole-codebase +
 * diff context, runs the configured engine, and persists structured findings.
 * State transitions / progress / PR comment write-back are the worker's job
 * (next milestone); this service is the pure produce-and-persist core.
 */
export class ReviewService {
  private graphCache?: GraphCacheService;

  constructor(private readonly deps: ReviewServiceDeps) {}

  /** Lazily construct (and reuse) the shared base-graph cache from config. */
  private getGraphCache(): GraphCacheService {
    if (this.deps.graphCache) return this.deps.graphCache;
    if (!this.graphCache) {
      const review = this.deps.config.review;
      this.graphCache = new GraphCacheService({
        // Default under ./data/ — the server's persistent-volume convention
        // (same place as the SQLite DB), so cached graphs survive restarts and
        // are reused across review tasks rather than rebuilt each time.
        cacheRoot: review.codeGraphCacheDir || "./data/graph-cache",
        launcher: review.codeGraphLauncher,
        ttlMs: review.codeGraphTtlMs,
        timeoutMs: this.deps.config.worker.engineTimeoutMs,
      });
    }
    return this.graphCache;
  }

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

      // Enrich with code-review-graph structural analysis (risk-scored
      // hotspots, test gaps, affected flows) via the shared per-repo base graph.
      // Best-effort: undefined when the graph is unavailable, leaving the
      // review unchanged. Concurrent PRs on the same repo query it in parallel.
      // Skipped for the mock engine, which ignores the prompt entirely.
      if (this.deps.config.review.structuralContext && kind !== "mock") {
        const cloneUrl = await provider.cloneUrl({ fullName: repo.fullName });
        context.structuralContext = await ensureStructuralContext(context, {
          cache: this.getGraphCache(),
          repo: {
            platform: repo.platform,
            fullName: repo.fullName,
            cloneUrl,
            baseBranch: pr.targetBranch,
          },
          ...(this.deps.engineDeps?.commandRunner
            ? { commandRunner: this.deps.engineDeps.commandRunner }
            : {}),
        });
      }

      const drafts = await engine.review(context);
      // Token consumption for this ad-hoc review task (best-effort; never fails
      // the review). Attributed to the repo under the "task" source.
      if (engine.lastUsage) {
        await this.deps.repo
          .recordTokenUsage({
            source: "task",
            sourceId: repo.fullName,
            sourceLabel: repo.fullName,
            engine: kind,
            inputTokens: engine.lastUsage.inputTokens,
            outputTokens: engine.lastUsage.outputTokens,
            estimated: engine.lastUsage.estimated,
          })
          .catch(() => {});
      }
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
