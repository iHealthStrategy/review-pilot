import type { Repo } from "../domain/entities.js";
import type { Repository } from "../persistence/repository.js";
import type { ReviewContext, ReviewEngine } from "./review-engine.js";

export interface ProjectInsightOptions {
  /** Regenerate the cached understanding once it is older than this (ms). */
  ttlMs: number;
  /** Clock for staleness checks (injectable for tests). */
  now?: () => number;
}

/**
 * Maintains a per-repo "whole-project understanding" cache. On each review it
 * returns the cached summary when still fresh; otherwise it asks the (agentic)
 * engine to explore the checkout and summarise the project, persists that, and
 * returns it. Engines that can't explore (no `summarize`) simply yield the
 * existing cache or nothing — so this is a no-op for the mock engine.
 *
 * The point: each PR review is grounded in global context without paying for a
 * full re-exploration every time.
 */
export class ProjectInsightService {
  constructor(
    private readonly repo: Repository,
    private readonly options: ProjectInsightOptions,
  ) {}

  async ensure(
    engine: ReviewEngine,
    repoEntity: Repo,
    ctx: ReviewContext,
  ): Promise<string | undefined> {
    const cached = await this.repo.getRepoInsight(repoEntity.id);
    const now = (this.options.now ?? Date.now)();
    if (cached && now - Date.parse(cached.updatedAt) < this.options.ttlMs) {
      return cached.summary;
    }
    if (!engine.summarize) return cached?.summary;

    const summary = await engine.summarize(ctx);
    await this.repo.upsertRepoInsight({
      repoId: repoEntity.id,
      summary,
      headSha: ctx.pullRequest.headSha,
    });
    return summary;
  }
}
