import type {
  Platform,
  PullRequest,
  ReviewEngineKind,
  ReviewJob,
} from "../domain/entities.js";
import type { Repository } from "../persistence/repository.js";
import type {
  GitProvider,
  ProviderPullRequest,
  WebhookRequest,
} from "../providers/git-provider.js";

/** Outcome of handling a single inbound event. */
export type TriggerOutcome =
  | { status: "created"; jobId: string; pullRequestId: string }
  | { status: "deduped"; jobId: string; pullRequestId: string }
  | { status: "ignored"; reason: string }
  | { status: "rejected"; reason: string };

export interface TriggerServiceDeps {
  repo: Repository;
  /** Resolve the provider for a platform (injected for testability). */
  providerFor: (platform: Platform) => GitProvider;
  /** Engine assigned to newly-created jobs. */
  defaultEngine: ReviewEngineKind;
}

/**
 * Turns inbound PR/MR signals — verified webhooks and polling discoveries —
 * into deduplicated {@link ReviewJob}s. Both paths funnel through
 * {@link TriggerService.enqueue}, so "same PR seen twice" creates exactly one
 * active job regardless of source.
 */
export class TriggerService {
  constructor(private readonly deps: TriggerServiceDeps) {}

  /** Verify + parse a webhook and enqueue a review job (idempotently). */
  async handleWebhook(
    platform: Platform,
    req: WebhookRequest,
  ): Promise<TriggerOutcome> {
    const provider = this.deps.providerFor(platform);

    const verification = provider.verifyWebhook(req);
    if (!verification.valid) {
      return { status: "rejected", reason: verification.reason ?? "invalid signature" };
    }

    const event = provider.parseWebhook(req);
    if (!event) return { status: "ignored", reason: "not a pull-request event" };

    // A closing/merging PR should cancel any still-pending review for it.
    if (event.closing) {
      const repo = await this.deps.repo.findRepoByFullName(
        platform,
        event.repoFullName,
      );
      const cancelled = repo
        ? await this.cancelPending(repo.id, event.number)
        : 0;
      return {
        status: "ignored",
        reason: `pr closing (${event.action}); cancelled ${cancelled} pending job(s)`,
      };
    }

    if (!event.reviewable) {
      return { status: "ignored", reason: `non-reviewable action: ${event.action}` };
    }

    const repo = await this.deps.repo.findRepoByFullName(
      platform,
      event.repoFullName,
    );
    if (!repo) {
      return { status: "ignored", reason: `repo not monitored: ${event.repoFullName}` };
    }

    // Enrich with full PR metadata so the stored record is complete.
    const meta = await provider.getPullRequest(
      { fullName: repo.fullName },
      event.number,
    );
    const pr = await this.deps.repo.upsertPullRequest({
      repoId: repo.id,
      ...prFields(meta),
    });
    return this.enqueue(pr);
  }

  /**
   * API-triggered review: fetch PR metadata from the provider, upsert the PR
   * record, and enqueue a job — same dedup as the webhook path.
   * Returns "ignored" (with a reason) when the repo is not monitored.
   */
  async enqueueByNumber(
    platform: Platform,
    repoFullName: string,
    prNumber: number,
  ): Promise<TriggerOutcome> {
    const repo = await this.deps.repo.findRepoByFullName(platform, repoFullName);
    if (!repo) {
      return { status: "ignored", reason: `repo not monitored: ${repoFullName}` };
    }
    const provider = this.deps.providerFor(platform);
    const meta = await provider.getPullRequest({ fullName: repoFullName }, prNumber);
    const pr = await this.deps.repo.upsertPullRequest({
      repoId: repo.id,
      ...prFields(meta),
    });
    return this.enqueue(pr);
  }

  /**
   * Polling fallback: scan every monitored repo for open PRs and enqueue any
   * that lack an active job. Shares dedup with the webhook path.
   */
  async pollAll(): Promise<TriggerOutcome[]> {
    const repos = await this.deps.repo.listRepos();
    const outcomes: TriggerOutcome[] = [];
    for (const repo of repos) {
      const provider = this.deps.providerFor(repo.platform);
      const open = await provider.listOpenPullRequests({ fullName: repo.fullName });
      for (const meta of open) {
        const pr = await this.deps.repo.upsertPullRequest({
          repoId: repo.id,
          ...prFields(meta),
        });
        outcomes.push(await this.enqueue(pr));
      }
    }
    return outcomes;
  }

  /** Cancel pending jobs for a (now-closing) PR. Returns how many were cancelled. */
  private async cancelPending(repoId: string, number: number): Promise<number> {
    const pr = await this.deps.repo.findPullRequest(repoId, number);
    if (!pr) return 0;
    const jobs = await this.deps.repo.listReviewJobs({ pullRequestId: pr.id });
    const pending = jobs.filter((j: ReviewJob) => j.status === "pending");
    for (const job of pending) {
      await this.deps.repo.transitionReviewJob(job.id, "failed", {
        error: "pull request closed before review ran",
      });
    }
    return pending.length;
  }

  /** Create a job for a PR unless one is already pending/running. */
  private async enqueue(pr: PullRequest): Promise<TriggerOutcome> {
    const jobs = await this.deps.repo.listReviewJobs({ pullRequestId: pr.id });
    const active = jobs.find(
      (j: ReviewJob) => j.status === "pending" || j.status === "running",
    );
    if (active) {
      return { status: "deduped", jobId: active.id, pullRequestId: pr.id };
    }
    const job = await this.deps.repo.createReviewJob({
      pullRequestId: pr.id,
      engine: this.deps.defaultEngine,
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
