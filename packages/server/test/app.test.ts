import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startAppServer } from "../src/app.js";
import type { Platform } from "../src/domain/entities.js";
import { MemoryRepository } from "../src/persistence/memory-repository.js";
import type { Repository } from "../src/persistence/repository.js";
import { TaskService } from "../src/trigger/trigger-service.js";
import { makeSession } from "./auth-helper.js";
import { fixedClock, seqIdGen } from "./repository-contract.js";
import { SpyProvider } from "./spy-provider.js";

async function startServer(
  repo: Repository,
  opts: { sessionSecret?: string; webDistDir?: string },
) {
  const taskService = new TaskService({
    repo,
    providerFor: (_p: Platform) => new SpyProvider(),
    defaultEngine: "mock",
    enabledEngines: ["mock"],
  });
  const server = startAppServer({ repo, taskService, ...opts }, 0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const port = (server.address() as AddressInfo).port;
  return { server, base: `http://127.0.0.1:${port}` };
}

test("app: auth gates /api (session token) but leaves health open", async () => {
  const repo = new MemoryRepository({ clock: fixedClock(), idGen: seqIdGen() });
  await repo.init();
  const { server, base } = await startServer(repo, { sessionSecret: "secret" });
  try {
    // No credential → 401; health probe stays open.
    assert.equal((await fetch(`${base}/api/projects`)).status, 401);
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    // A signed session (post-OIDC) authenticates the bearer.
    const { token } = await makeSession(repo, "secret", "admin");
    const ok = await fetch(`${base}/api/projects`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(ok.status, 200);
    const wrong = await fetch(`${base}/api/projects`, {
      headers: { authorization: "Bearer not.a.token" },
    });
    assert.equal(wrong.status, 401);
  } finally {
    server.close();
  }
});

test("app: serves the static Web UI from the configured dist dir", async () => {
  const dist = await mkdtemp(join(tmpdir(), "rp-web-"));
  await writeFile(join(dist, "index.html"), "<!doctype html><title>ReviewPilot</title>", "utf8");
  const repo = new MemoryRepository({ clock: fixedClock(), idGen: seqIdGen() });
  await repo.init();
  const { server, base } = await startServer(repo, { webDistDir: dist });
  try {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await res.text(), /ReviewPilot/);
    // SPA fallback: unknown non-asset path returns index.html.
    assert.equal((await fetch(`${base}/jobs`)).status, 200);
  } finally {
    server.close();
  }
});

test("app: POST /api/jobs/:id/retry requeues a failed job", async () => {
  const repo = new MemoryRepository({ clock: fixedClock(), idGen: seqIdGen() });
  await repo.init();
  const project = await repo.createProject({
    name: "d",
    platform: "github",
    defaultEngine: "mock",
    enabledEngines: ["mock"],
  });
  const r = await repo.createRepo({
    projectId: project.id,
    platform: "github",
    fullName: "a/b",
    remoteUrl: "u",
    cloneUrl: "u.git",
    defaultBranch: "main",
  });
  const pr = await repo.upsertPullRequest({
    repoId: r.id,
    number: 1,
    title: "t",
    sourceBranch: "f",
    targetBranch: "main",
    headSha: "s",
    author: "a",
    url: "u",
    state: "open",
  });
  const job = await repo.createReviewJob({ pullRequestId: pr.id, engine: "mock" });
  await repo.transitionReviewJob(job.id, "running");
  await repo.transitionReviewJob(job.id, "failed", { error: "boom" });

  const { server, base } = await startServer(repo, {});
  try {
    // Cannot retry a non-failed job.
    const job2 = await repo.createReviewJob({ pullRequestId: pr.id, engine: "mock" });
    assert.equal(
      (await fetch(`${base}/api/jobs/${job2.id}/retry`, { method: "POST" })).status,
      409,
    );
    const res = await fetch(`${base}/api/jobs/${job.id}/retry`, { method: "POST" });
    assert.equal(res.status, 200);
    assert.equal((await repo.getReviewJob(job.id))?.status, "pending");
  } finally {
    server.close();
  }
});
