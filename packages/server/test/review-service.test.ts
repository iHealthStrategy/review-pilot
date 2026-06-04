import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import type { Platform } from "../src/domain/entities.js";
import { MemoryRepository } from "../src/persistence/memory-repository.js";
import { GitHubProvider } from "../src/providers/github-provider.js";
import type { GitProvider } from "../src/providers/git-provider.js";
import { ReviewService } from "../src/review/review-service.js";
import { FakeHttpClient, type Route } from "./fake-http-client.js";
import { FakeCloner } from "./fake-cloner.js";
import { fixedClock, seqIdGen } from "./repository-contract.js";

const ghFiles = [
  { filename: "src/new.ts", status: "added", additions: 10, deletions: 0 },
  { filename: "src/mod.ts", status: "modified", additions: 3, deletions: 1 },
];
const routes: Route[] = [
  { method: "GET", urlIncludes: "pulls/7/files", body: ghFiles },
];

function providerFor(_platform: Platform): GitProvider {
  return new GitHubProvider(new FakeHttpClient(routes), {
    apiBase: "https://api.github.com",
    token: "",
    webhookSecret: "s",
  });
}

test("ReviewService: syncs full repo, reviews with mock engine, persists findings", async () => {
  const repo = new MemoryRepository({ clock: fixedClock(), idGen: seqIdGen() });
  await repo.init();
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
  const pr = await repo.upsertPullRequest({
    repoId: r.id,
    number: 7,
    title: "Add feature",
    sourceBranch: "feat",
    targetBranch: "main",
    headSha: "abc123",
    author: "alice",
    url: "https://github.com/acme/demo/pull/7",
    state: "open",
  });
  const job = await repo.createReviewJob({ pullRequestId: pr.id, engine: "mock" });

  // Full repo has mod.ts + README, but NOT new.ts → engine should flag it as
  // not present in the synced tree, proving whole-codebase context.
  const cloner = new FakeCloner({
    "README.md": "# demo",
    "src/mod.ts": "export const x = 1;",
  });

  const service = new ReviewService({
    repo,
    config: loadConfig({}),
    providerFor,
    cloner,
  });

  const { findings, context } = await service.review(job.id);

  // Full repository was synced and scanned (structure, not just diff).
  assert.deepEqual(context.structure, ["README.md", "src/mod.ts"]);
  assert.equal(context.diff.length, 2);
  assert.equal(cloner.cloneCalls[0]?.ref, "abc123");
  assert.equal(cloner.cleanups, 1); // workspace cleaned up

  // Structured findings produced and persisted.
  assert.equal(findings.length, 2);
  const persisted = await repo.listFindings(job.id);
  assert.equal(persisted.length, 2);
  const added = persisted.find((f) => f.filePath === "src/new.ts");
  assert.match(added!.detail, /not present in synced tree/);
});
