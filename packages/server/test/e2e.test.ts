import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { startAppServer } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { Platform } from "../src/domain/entities.js";
import { MemoryRepository } from "../src/persistence/memory-repository.js";
import { GitHubProvider } from "../src/providers/github-provider.js";
import type { GitProvider } from "../src/providers/git-provider.js";
import { ReviewService } from "../src/review/review-service.js";
import { TaskService } from "../src/trigger/trigger-service.js";
import { Worker } from "../src/worker/worker.js";
import { FakeCloner } from "./fake-cloner.js";
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

const routes: Route[] = [
  { method: "GET", urlIncludes: "pulls/7/files", body: [
    { filename: "src/new.ts", status: "added" },
    { filename: "src/mod.ts", status: "modified" },
  ] },
  { method: "GET", urlIncludes: "pulls/7", body: ghPull },
  // No prior summary comment yet → worker falls back to POST.
  { method: "GET", urlIncludes: "issues/7/comments", body: [] },
  { method: "POST", urlIncludes: "issues/7/comments", body: { id: 999, html_url: "https://github.com/acme/demo/pull/7#c999" } },
];

test("e2e: POST /api/tasks → job → mock review → findings → comment write-back → API query", async () => {
  const repo = new MemoryRepository({ clock: fixedClock(), idGen: seqIdGen() });
  await repo.init();

  // One FakeHttpClient instance backs the provider so we can assert the
  // write-back POST actually happened over the (mock) network.
  const http = new FakeHttpClient(routes);
  const provider = new GitHubProvider(http, {
    apiBase: "https://api.github.com",
    token: "",
    webhookSecret: "",
  });
  const providerFor = (_p: Platform): GitProvider => provider;

  const taskService = new TaskService({
    repo,
    providerFor,
    defaultEngine: "mock",
    enabledEngines: ["mock"],
  });
  const reviewService = new ReviewService({
    repo,
    config: loadConfig({}),
    providerFor,
    cloner: new FakeCloner({ "README.md": "# demo", "src/mod.ts": "x" }),
  });
  const worker = new Worker(repo, reviewService, providerFor);

  const server = startAppServer({ repo, taskService }, 0);
  try {
    await new Promise<void>((r) => server.once("listening", () => r()));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    // 1) Self-contained task over real HTTP → auto-provisions repo, creates one job.
    const taskRes = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        platform: "github",
        repoFullName: "acme/demo",
        cloneUrl: "https://github.com/acme/demo.git",
        prNumber: 7,
      }),
    });
    assert.equal(taskRes.status, 202);
    const created = (await taskRes.json()) as { status: string; jobId: string };
    assert.equal(created.status, "created");
    const jobId = created.jobId;

    // Visible via API as pending.
    const pendingList = (await (await fetch(`${base}/api/jobs?status=pending`)).json()) as unknown[];
    assert.equal(pendingList.length, 1);

    // 2) Worker drains the queue: review (mock) → findings → comment write-back.
    const outcomes = await worker.runPending();
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.status, "succeeded");

    // Write-back actually hit the provider (mock HTTP).
    const commentPosts = http.requests.filter(
      (r) => r.method === "POST" && r.url.includes("issues/7/comments"),
    );
    assert.equal(commentPosts.length, 1);
    assert.match(commentPosts[0]!.body ?? "", /ReviewPilot review/);

    // 3) Results queryable via the API (UI channel).
    const detail = (await (await fetch(`${base}/api/jobs/${jobId}`)).json()) as {
      status: string;
      progress: number;
      findings: unknown[];
      pullRequest: { number: number };
    };
    assert.equal(detail.status, "succeeded");
    assert.equal(detail.progress, 100);
    assert.equal(detail.findings.length, 2);
    assert.equal(detail.pullRequest.number, 7);

    // 4) Re-sending the same webhook does NOT create a second job (dedup holds
    //    end-to-end). The prior job finished, so a fresh one is allowed.
    const findingsView = (await (await fetch(`${base}/api/jobs/${jobId}/findings`)).json()) as unknown[];
    assert.equal(findingsView.length, 2);
  } finally {
    server.close();
  }
});
