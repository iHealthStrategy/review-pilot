import assert from "node:assert/strict";
import { test } from "node:test";
import type { Platform } from "../src/domain/entities.js";
import { MemoryRepository } from "../src/persistence/memory-repository.js";
import type { Repository } from "../src/persistence/repository.js";
import { GitHubProvider } from "../src/providers/github-provider.js";
import type { GitProvider } from "../src/providers/git-provider.js";
import { TaskService } from "../src/trigger/trigger-service.js";
import { FakeHttpClient, type Route } from "./fake-http-client.js";
import { fixedClock, seqIdGen } from "./repository-contract.js";

const ghPull = {
  number: 7,
  title: "Add feature",
  state: "open",
  html_url: "https://github.com/acme/demo/pull/7",
  user: { login: "alice" },
  head: { ref: "feat", sha: "abc123" },
  base: { ref: "main" },
};

const ghRoutes: Route[] = [{ method: "GET", urlIncludes: "pulls/7", body: ghPull }];

function providerFor(_platform: Platform): GitProvider {
  return new GitHubProvider(new FakeHttpClient(ghRoutes), {
    apiBase: "https://api.github.com",
    token: "",
    webhookSecret: "",
  });
}

async function makeService(): Promise<{ repo: Repository; service: TaskService }> {
  const repo = new MemoryRepository({ clock: fixedClock(), idGen: seqIdGen() });
  await repo.init();
  const service = new TaskService({
    repo,
    providerFor,
    defaultEngine: "mock",
    enabledEngines: ["mock"],
  });
  return { repo, service };
}

const task = {
  platform: "github" as Platform,
  repoFullName: "acme/demo",
  cloneUrl: "https://github.com/acme/demo.git",
  prNumber: 7,
};

test("TaskService: auto-provisions project + repo and creates one job", async () => {
  const { repo, service } = await makeService();
  // No project/repo pre-registered — the task is self-contained.
  assert.equal((await repo.listProjects()).length, 0);

  const outcome = await service.createTask(task);
  assert.equal(outcome.status, "created");

  // A default project and an ad-hoc repo were provisioned.
  assert.equal((await repo.listProjects()).length, 1);
  const r = await repo.findRepoByFullName("github", "acme/demo");
  assert.equal(r?.cloneUrl, "https://github.com/acme/demo.git");

  // PR metadata was fetched from the provider and persisted.
  assert.equal((await repo.listReviewJobs()).length, 1);
  const pr = await repo.getPullRequest(
    outcome.status === "created" ? outcome.pullRequestId : "",
  );
  assert.equal(pr?.title, "Add feature");
  assert.equal(pr?.headSha, "abc123");
});

test("TaskService: a repeated task for the same PR is deduped", async () => {
  const { repo, service } = await makeService();
  const first = await service.createTask(task);
  assert.equal(first.status, "created");

  const second = await service.createTask(task);
  assert.equal(second.status, "deduped");
  assert.equal(
    second.status === "deduped" && second.jobId,
    first.status === "created" && first.jobId,
  );
  assert.equal((await repo.listReviewJobs()).length, 1);
  // The default project is reused, not re-created.
  assert.equal((await repo.listProjects()).length, 1);
});

test("TaskService: a new job is created after the previous one finishes", async () => {
  const { repo, service } = await makeService();
  const first = await service.createTask(task);
  const jobId = first.status === "created" ? first.jobId : "";
  await repo.transitionReviewJob(jobId, "running");
  await repo.transitionReviewJob(jobId, "succeeded");

  const again = await service.createTask(task);
  assert.equal(again.status, "created");
  assert.equal((await repo.listReviewJobs()).length, 2);
});

test("TaskService: derives a clone URL when the task omits one", async () => {
  const { repo, service } = await makeService();
  await service.createTask({
    platform: "github",
    repoFullName: "acme/demo",
    prNumber: 7,
  });
  const r = await repo.findRepoByFullName("github", "acme/demo");
  assert.equal(r?.cloneUrl, "https://github.com/acme/demo.git");
});
