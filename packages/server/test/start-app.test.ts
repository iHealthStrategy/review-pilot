import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import type { Platform } from "../src/domain/entities.js";
import { startApp } from "../src/index.js";
import { FakeCloner } from "./fake-cloner.js";
import { SpyProvider } from "./spy-provider.js";

/**
 * Integration test for the long-running production wiring: startApp's periodic
 * worker drain must automatically pick up a pending job and run it to
 * completion (review → findings → write-back). Uses a short drain interval +
 * injected fakes so it is fast and deterministic, with PORT=0 (ephemeral).
 */
test("startApp: background drain auto-processes a pending job", async () => {
  const spy = new SpyProvider();
  const providerFor = (_p: Platform) => spy;
  const cloner = new FakeCloner({ "README.md": "# demo", "src/mod.ts": "x" });

  const app = startApp(loadConfig({ PORT: "0", DB_DRIVER: "mock" }), {
    providerFor,
    cloner,
    drainIntervalMs: 20,
  });

  try {
    // Seed a monitored repo + PR + pending job via the running app's repo.
    const project = await app.repo.createProject({
      name: "demo",
      platform: "github",
      defaultEngine: "mock",
      enabledEngines: ["mock"],
    });
    const repo = await app.repo.createRepo({
      projectId: project.id,
      platform: "github",
      fullName: "acme/demo",
      remoteUrl: "https://github.com/acme/demo",
      cloneUrl: "https://github.com/acme/demo.git",
      defaultBranch: "main",
    });
    const pr = await app.repo.upsertPullRequest({
      repoId: repo.id,
      number: 7,
      title: "Add feature",
      sourceBranch: "feat",
      targetBranch: "main",
      headSha: "abc123",
      author: "alice",
      url: "https://github.com/acme/demo/pull/7",
      state: "open",
    });
    const job = await app.repo.createReviewJob({ pullRequestId: pr.id, engine: "mock" });

    // Wait for the background drain to take it to a terminal state.
    let status = "pending";
    for (let i = 0; i < 100; i++) {
      const j = await app.repo.getReviewJob(job.id);
      status = j?.status ?? "pending";
      if (status === "succeeded" || status === "failed") break;
      await sleep(20);
    }

    assert.equal(status, "succeeded");
    assert.ok(spy.comments.length >= 1, "summary comment should have been posted");
    assert.equal((await app.repo.listFindings(job.id)).length, 2);
  } finally {
    await app.close();
  }
});
