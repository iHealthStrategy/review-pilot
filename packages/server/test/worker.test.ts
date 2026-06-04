import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import type { Platform, Repo } from "../src/domain/entities.js";
import { MemoryRepository } from "../src/persistence/memory-repository.js";
import type { Repository } from "../src/persistence/repository.js";
import { ReviewService } from "../src/review/review-service.js";
import { Worker } from "../src/worker/worker.js";
import { FakeCloner } from "./fake-cloner.js";
import { fixedClock, seqIdGen } from "./repository-contract.js";
import { SpyProvider } from "./spy-provider.js";

async function seed(repo: Repository, prNumbers: number[]): Promise<{ repo: Repo; jobIds: string[] }> {
  const project = await repo.createProject({
    name: "demo",
    platform: "github",
    defaultEngine: "mock",
    enabledEngines: ["mock"],
  });
  const r = await repo.createRepo({
    projectId: project.id,
    platform: "github",
    fullName: "acme/demo",
    remoteUrl: "https://github.com/acme/demo",
    cloneUrl: "https://github.com/acme/demo.git",
    defaultBranch: "main",
  });
  const jobIds: string[] = [];
  for (const n of prNumbers) {
    const pr = await repo.upsertPullRequest({
      repoId: r.id,
      number: n,
      title: `PR ${n}`,
      sourceBranch: "feat",
      targetBranch: "main",
      headSha: "abc123",
      author: "alice",
      url: `https://github.com/acme/demo/pull/${n}`,
      state: "open",
    });
    const job = await repo.createReviewJob({ pullRequestId: pr.id, engine: "mock" });
    jobIds.push(job.id);
  }
  return { repo: r, jobIds };
}

function makeWorker(repo: Repository, spy: SpyProvider, opts = {}) {
  const providerFor = (_p: Platform) => spy;
  const cloner = new FakeCloner({ "README.md": "# demo", "src/mod.ts": "x" });
  const reviewService = new ReviewService({
    repo,
    config: loadConfig({}),
    providerFor,
    cloner,
  });
  return { worker: new Worker(repo, reviewService, providerFor, opts), cloner };
}

test("Worker: runs a job end-to-end and writes back a summary comment", async () => {
  const repo = new MemoryRepository({ clock: fixedClock(), idGen: seqIdGen() });
  await repo.init();
  const { jobIds } = await seed(repo, [7]);
  const spy = new SpyProvider();
  const { worker } = makeWorker(repo, spy);

  const outcome = await worker.runJob(jobIds[0]!);
  assert.equal(outcome.status, "succeeded");
  assert.equal(outcome.status === "succeeded" && outcome.findings, 2);

  // Write-back was invoked on the provider.
  assert.equal(spy.comments.length, 1);
  assert.match(spy.comments[0]!.body, /ReviewPilot review/);
  assert.match(spy.comments[0]!.body, /finding\(s\)/);

  // Job advanced through the state machine with progress + logs.
  const job = await repo.getReviewJob(jobIds[0]!);
  assert.equal(job?.status, "succeeded");
  assert.equal(job?.progress, 100);
  assert.ok(job!.logs.length >= 3);
  assert.ok(job!.startedAt && job!.finishedAt);

  // Findings persisted for the UI channel.
  assert.equal((await repo.listFindings(jobIds[0]!)).length, 2);
});

test("Worker: posts inline comments when enabled", async () => {
  const repo = new MemoryRepository({ clock: fixedClock(), idGen: seqIdGen() });
  await repo.init();
  const { jobIds } = await seed(repo, [7]);
  const spy = new SpyProvider();
  const { worker } = makeWorker(repo, spy, { inlineComments: true });

  await worker.runJob(jobIds[0]!);
  // Mock engine sets line=1 on every finding → both get inline comments.
  assert.equal(spy.inline.length, 2);
  assert.equal(spy.inline[0]?.input.commitSha, "abc123");
});

test("Worker: publishes a Check Run with annotations + gate when enabled", async () => {
  const repo = new MemoryRepository({ clock: fixedClock(), idGen: seqIdGen() });
  await repo.init();
  const { jobIds } = await seed(repo, [7]);
  const spy = new SpyProvider();
  const { worker } = makeWorker(repo, spy, {
    publishCheckRun: true,
    failOnSeverity: "minor",
  });

  await worker.runJob(jobIds[0]!);
  assert.equal(spy.checkRuns.length, 1);
  // Mock engine emits minor findings on changed files, each with line=1.
  assert.equal(spy.checkRuns[0]?.conclusion, "failure"); // minor >= minor gate
  assert.equal(spy.checkRuns[0]?.headSha, "abc123");
  assert.ok((spy.checkRuns[0]?.annotations?.length ?? 0) >= 1);
});

test("Worker: failure sets job failed and it can be retried to success", async () => {
  const repo = new MemoryRepository({ clock: fixedClock(), idGen: seqIdGen() });
  await repo.init();
  const { jobIds } = await seed(repo, [7]);
  const spy = new SpyProvider();
  spy.failDiffTimes = 1; // first review attempt throws
  const { worker } = makeWorker(repo, spy);

  const failed = await worker.runJob(jobIds[0]!);
  assert.equal(failed.status, "failed");
  let job = await repo.getReviewJob(jobIds[0]!);
  assert.equal(job?.status, "failed");
  assert.match(job?.error ?? "", /diff fetch failure/);
  assert.equal(spy.comments.length, 0);

  const retried = await worker.retry(jobIds[0]!);
  assert.equal(retried.status, "succeeded");
  job = await repo.getReviewJob(jobIds[0]!);
  assert.equal(job?.status, "succeeded");
  assert.equal(job?.attempts, 2); // ran twice
  assert.equal(spy.comments.length, 1);
});

test("Worker: runPending processes every pending job (concurrency)", async () => {
  const repo = new MemoryRepository({ clock: fixedClock(), idGen: seqIdGen() });
  await repo.init();
  const { jobIds } = await seed(repo, [7, 8, 9]);
  const spy = new SpyProvider();
  const { worker } = makeWorker(repo, spy, { concurrency: 2 });

  const outcomes = await worker.runPending();
  assert.equal(outcomes.length, 3);
  assert.ok(outcomes.every((o) => o.status === "succeeded"));
  assert.equal(spy.comments.length, 3);
  assert.equal((await repo.listReviewJobs({ status: "succeeded" })).length, 3);
  assert.equal((await repo.listReviewJobs({ status: "pending" })).length, 0);
  assert.deepEqual(jobIds.length, 3);
});

test("Worker: updates the prior summary comment instead of posting a new one", async () => {
  const repo = new MemoryRepository({ clock: fixedClock(), idGen: seqIdGen() });
  await repo.init();
  await seed(repo, [7]);
  const pr = await repo.findPullRequest((await repo.listRepos())[0]!.id, 7);

  // Provider that supports list/update so the worker dedups its comment.
  class DedupProvider extends SpyProvider {
    updates: { id: string; body: string }[] = [];
    async listComments() {
      return this.comments.map((c, i) => ({ id: String(i + 1), body: c.body }));
    }
    async updateComment(_r: unknown, _n: number, id: string, body: string) {
      this.updates.push({ id, body });
      return { id };
    }
  }
  const spy = new DedupProvider();
  const { worker } = makeWorker(repo, spy);

  // First review for PR #7 → posts a fresh comment.
  const firstJob = (await repo.listReviewJobs())[0]!;
  await worker.runJob(firstJob.id);
  assert.equal(spy.comments.length, 1);
  assert.equal(spy.updates.length, 0);

  // A re-review (new push → new job) updates the SAME comment, no new post.
  const secondJob = await repo.createReviewJob({ pullRequestId: pr!.id, engine: "mock" });
  await worker.runJob(secondJob.id);
  assert.equal(spy.comments.length, 1, "no second comment posted");
  assert.equal(spy.updates.length, 1, "prior comment updated in place");
});

test("Worker: recoverInterrupted requeues jobs stranded in running", async () => {
  const repo = new MemoryRepository({ clock: fixedClock(), idGen: seqIdGen() });
  await repo.init();
  const { jobIds } = await seed(repo, [7]);
  // Simulate a crash mid-run: job left in `running`.
  await repo.transitionReviewJob(jobIds[0]!, "running");
  const spy = new SpyProvider();
  const { worker } = makeWorker(repo, spy);

  const recovered = await worker.recoverInterrupted();
  assert.equal(recovered, 1);
  const job = await repo.getReviewJob(jobIds[0]!);
  assert.equal(job?.status, "pending");

  // And it can now be drained to success via the atomic-claim path.
  const outcomes = await worker.runPending();
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]?.status, "succeeded");
});

test("Worker: skips a non-pending job", async () => {
  const repo = new MemoryRepository({ clock: fixedClock(), idGen: seqIdGen() });
  await repo.init();
  const { jobIds } = await seed(repo, [7]);
  await repo.transitionReviewJob(jobIds[0]!, "running");
  const spy = new SpyProvider();
  const { worker } = makeWorker(repo, spy);
  const outcome = await worker.runJob(jobIds[0]!);
  assert.equal(outcome.status, "skipped");
});
