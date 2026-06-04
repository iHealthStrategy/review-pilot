import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import type { Platform } from "../src/domain/entities.js";
import { MemoryRepository } from "../src/persistence/memory-repository.js";
import type { Repository } from "../src/persistence/repository.js";
import { GitHubProvider } from "../src/providers/github-provider.js";
import type { GitProvider } from "../src/providers/git-provider.js";
import { GitLabProvider } from "../src/providers/gitlab-provider.js";
import { TriggerService } from "../src/trigger/trigger-service.js";
import { FakeHttpClient, type Route } from "./fake-http-client.js";
import { fixedClock, seqIdGen } from "./repository-contract.js";

const GH_SECRET = "s3cret";
const GL_SECRET = "gl-token";

const ghPull = {
  number: 7,
  title: "Add feature",
  state: "open",
  html_url: "https://github.com/acme/demo/pull/7",
  user: { login: "alice" },
  head: { ref: "feat", sha: "abc123" },
  base: { ref: "main" },
};

const glMr = {
  iid: 7,
  title: "Add feature",
  state: "opened",
  web_url: "https://gitlab.com/acme/demo/-/merge_requests/7",
  source_branch: "feat",
  target_branch: "main",
  sha: "abc123",
  author: { username: "alice" },
};

const ghRoutes: Route[] = [{ method: "GET", urlIncludes: "pulls/7", body: ghPull }];
const glRoutes: Route[] = [
  { method: "GET", urlIncludes: "merge_requests?state=opened", body: [glMr] },
];

function ghProvider(): GitProvider {
  return new GitHubProvider(new FakeHttpClient(ghRoutes), {
    apiBase: "https://api.github.com",
    token: "",
    webhookSecret: GH_SECRET,
  });
}

function glProvider(): GitProvider {
  return new GitLabProvider(new FakeHttpClient(glRoutes), {
    apiBase: "https://gitlab.com/api/v4",
    token: "",
    webhookSecret: GL_SECRET,
  });
}

function providerFor(platform: Platform): GitProvider {
  return platform === "github" ? ghProvider() : glProvider();
}

async function setup(platform: Platform): Promise<Repository> {
  const repo = new MemoryRepository({ clock: fixedClock(), idGen: seqIdGen() });
  await repo.init();
  const project = await repo.createProject({
    name: "demo",
    platform,
    defaultEngine: "mock",
    enabledEngines: ["mock"],
  });
  await repo.createRepo({
    projectId: project.id,
    platform,
    fullName: "acme/demo",
    remoteUrl: "https://host/acme/demo",
    cloneUrl: "https://host/acme/demo.git",
    defaultBranch: "main",
  });
  return repo;
}

function signedGithubWebhook(action: string, repoFullName = "acme/demo") {
  const rawBody = JSON.stringify({
    action,
    pull_request: { number: 7, head: { sha: "abc123" } },
    repository: { full_name: repoFullName },
  });
  const digest = createHmac("sha256", GH_SECRET).update(rawBody).digest("hex");
  return {
    headers: {
      "x-github-event": "pull_request",
      "x-hub-signature-256": `sha256=${digest}`,
    },
    rawBody,
  };
}

test("TriggerService: webhook creates exactly one job for a repeated PR event", async () => {
  const repo = await setup("github");
  const service = new TriggerService({ repo, providerFor, defaultEngine: "mock" });

  const first = await service.handleWebhook("github", signedGithubWebhook("opened"));
  assert.equal(first.status, "created");

  const second = await service.handleWebhook("github", signedGithubWebhook("synchronize"));
  assert.equal(second.status, "deduped");
  assert.equal(second.status === "deduped" && second.jobId, first.status === "created" && first.jobId);

  assert.equal((await repo.listReviewJobs()).length, 1);
  // PR metadata was enriched and persisted.
  const prs = await repo.listReviewJobs();
  const pr = await repo.getPullRequest(prs[0]!.pullRequestId);
  assert.equal(pr?.title, "Add feature");
  assert.equal(pr?.headSha, "abc123");
});

test("TriggerService: rejects an invalid signature", async () => {
  const repo = await setup("github");
  const service = new TriggerService({ repo, providerFor, defaultEngine: "mock" });
  const wh = signedGithubWebhook("opened");
  const tampered = { ...wh, rawBody: `${wh.rawBody} ` };
  const outcome = await service.handleWebhook("github", tampered);
  assert.equal(outcome.status, "rejected");
  assert.equal((await repo.listReviewJobs()).length, 0);
});

test("TriggerService: ignores non-reviewable actions", async () => {
  const repo = await setup("github");
  const service = new TriggerService({ repo, providerFor, defaultEngine: "mock" });
  const outcome = await service.handleWebhook("github", signedGithubWebhook("closed"));
  assert.equal(outcome.status, "ignored");
  assert.equal((await repo.listReviewJobs()).length, 0);
});

test("TriggerService: closing a PR cancels its pending job", async () => {
  const repo = await setup("github");
  const service = new TriggerService({ repo, providerFor, defaultEngine: "mock" });
  // Open → creates a pending job.
  const created = await service.handleWebhook("github", signedGithubWebhook("opened"));
  assert.equal(created.status, "created");
  const jobId = created.status === "created" ? created.jobId : "";

  // Close → the pending job is cancelled (failed), not left dangling.
  const closed = await service.handleWebhook("github", signedGithubWebhook("closed"));
  assert.equal(closed.status, "ignored");
  assert.match(
    closed.status === "ignored" ? closed.reason : "",
    /cancelled 1 pending job/,
  );
  assert.equal((await repo.getReviewJob(jobId))?.status, "failed");
});

test("TriggerService: ignores events for unmonitored repos", async () => {
  const repo = await setup("github");
  const service = new TriggerService({ repo, providerFor, defaultEngine: "mock" });
  const outcome = await service.handleWebhook(
    "github",
    signedGithubWebhook("opened", "other/repo"),
  );
  assert.equal(outcome.status, "ignored");
});

test("TriggerService: polling discovers a PR once and dedupes on re-poll", async () => {
  const repo = await setup("gitlab");
  const service = new TriggerService({ repo, providerFor, defaultEngine: "mock" });

  const round1 = await service.pollAll();
  assert.equal(round1.length, 1);
  assert.equal(round1[0]?.status, "created");

  const round2 = await service.pollAll();
  assert.equal(round2[0]?.status, "deduped");

  assert.equal((await repo.listReviewJobs()).length, 1);
});

test("TriggerService: a new job is created after the previous one finishes", async () => {
  const repo = await setup("github");
  const service = new TriggerService({ repo, providerFor, defaultEngine: "mock" });
  const first = await service.handleWebhook("github", signedGithubWebhook("opened"));
  assert.equal(first.status, "created");
  const jobId = first.status === "created" ? first.jobId : "";
  await repo.transitionReviewJob(jobId, "running");
  await repo.transitionReviewJob(jobId, "succeeded");

  const again = await service.handleWebhook("github", signedGithubWebhook("synchronize"));
  assert.equal(again.status, "created");
  assert.equal((await repo.listReviewJobs()).length, 2);
});
