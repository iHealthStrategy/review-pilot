import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { MemoryRepository } from "../src/persistence/memory-repository.js";
import { startApiServer } from "../src/api/rest-api.js";
import { fixedClock, seqIdGen } from "./repository-contract.js";

async function withApi(
  run: (base: string, repo: MemoryRepository) => Promise<void>,
): Promise<void> {
  const repo = new MemoryRepository({ clock: fixedClock(), idGen: seqIdGen() });
  await repo.init();
  const server = startApiServer(repo, 0);
  try {
    await new Promise<void>((r) => server.once("listening", () => r()));
    const port = (server.address() as AddressInfo).port;
    await run(`http://127.0.0.1:${port}`, repo);
  } finally {
    server.close();
  }
}

const json = (method: string, body?: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

test("REST: health check", async () => {
  await withApi(async (base) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { status: string }).status, "ok");
  });
});

test("REST: project CRUD + repo creation", async () => {
  await withApi(async (base) => {
    // Create
    const created = await fetch(
      `${base}/api/projects`,
      json("POST", {
        name: "demo",
        platform: "github",
        defaultEngine: "mock",
        enabledEngines: ["mock"],
      }),
    );
    assert.equal(created.status, 201);
    const project = (await created.json()) as { id: string };
    assert.ok(project.id);

    // List
    const list = (await (await fetch(`${base}/api/projects`)).json()) as unknown[];
    assert.equal(list.length, 1);

    // Add repo
    const repoRes = await fetch(
      `${base}/api/projects/${project.id}/repos`,
      json("POST", {
        platform: "github",
        fullName: "acme/demo",
        remoteUrl: "https://github.com/acme/demo",
        cloneUrl: "https://github.com/acme/demo.git",
        defaultBranch: "main",
      }),
    );
    assert.equal(repoRes.status, 201);

    // Detail includes repos
    const detail = (await (await fetch(`${base}/api/projects/${project.id}`)).json()) as {
      repos: unknown[];
    };
    assert.equal(detail.repos.length, 1);
  });
});

test("REST: validation rejects bad input with 400", async () => {
  await withApi(async (base) => {
    const res = await fetch(
      `${base}/api/projects`,
      json("POST", { name: "x", platform: "bitbucket", defaultEngine: "mock" }),
    );
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /platform/);
  });
});

test("REST: unknown project returns 404", async () => {
  await withApi(async (base) => {
    const res = await fetch(`${base}/api/projects/nope`);
    assert.equal(res.status, 404);
  });
});

test("REST: job detail aggregates pull request and findings", async () => {
  await withApi(async (base, repo) => {
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
      remoteUrl: "u",
      cloneUrl: "u.git",
      defaultBranch: "main",
    });
    const pr = await repo.upsertPullRequest({
      repoId: r.id,
      number: 7,
      title: "Add feature",
      sourceBranch: "feat",
      targetBranch: "main",
      headSha: "abc",
      author: "alice",
      url: "https://x/pr/7",
      state: "open",
    });
    const job = await repo.createReviewJob({ pullRequestId: pr.id, engine: "mock" });
    await repo.addFindings(job.id, [
      { filePath: "src/a.ts", line: 3, severity: "major", title: "Bug", detail: "d" },
    ]);

    const jobs = (await (await fetch(`${base}/api/jobs`)).json()) as unknown[];
    assert.equal(jobs.length, 1);

    const detail = (await (await fetch(`${base}/api/jobs/${job.id}`)).json()) as {
      pullRequest: { number: number };
      findings: unknown[];
    };
    assert.equal(detail.pullRequest.number, 7);
    assert.equal(detail.findings.length, 1);

    const findings = (await (
      await fetch(`${base}/api/jobs/${job.id}/findings`)
    ).json()) as unknown[];
    assert.equal(findings.length, 1);
  });
});

test("REST: jobs filter by status", async () => {
  await withApi(async (base, repo) => {
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

    const running = (await (
      await fetch(`${base}/api/jobs?status=running`)
    ).json()) as unknown[];
    assert.equal(running.length, 1);
    const pending = (await (
      await fetch(`${base}/api/jobs?status=pending`)
    ).json()) as unknown[];
    assert.equal(pending.length, 0);
  });
});
