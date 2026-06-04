import assert from "node:assert/strict";
import { test } from "node:test";
import type { Clock } from "../src/persistence/repository.js";
import { MemoryRepository } from "../src/persistence/memory-repository.js";
import { ProjectInsightService } from "../src/review/project-insight.js";
import type { ReviewContext, ReviewEngine } from "../src/review/review-engine.js";
import { seqIdGen } from "./repository-contract.js";

const FIXED = "2026-01-01T00:00:00.000Z";
const constClock: Clock = () => FIXED;
const T0 = Date.parse(FIXED);

function ctx(): ReviewContext {
  return {
    platform: "github",
    repoFullName: "acme/demo",
    pullRequest: {
      number: 7,
      title: "t",
      sourceBranch: "f",
      targetBranch: "main",
      headSha: "sha1",
      author: "a",
      url: "u",
    },
    structure: ["README.md"],
    diff: [],
    workspaceDir: "/tmp/ws",
  };
}

async function seedRepo() {
  const repo = new MemoryRepository({ clock: constClock, idGen: seqIdGen() });
  await repo.init();
  const project = await repo.createProject({
    name: "demo",
    platform: "github",
    defaultEngine: "claude-agent",
    enabledEngines: ["claude-agent"],
  });
  const r = await repo.createRepo({
    projectId: project.id,
    platform: "github",
    fullName: "acme/demo",
    remoteUrl: "u",
    cloneUrl: "u.git",
    defaultBranch: "main",
  });
  return { repo, r };
}

/** Engine stub that counts summarize() calls. */
function summarizingEngine(): ReviewEngine & { summarizeCalls: number } {
  return {
    kind: "claude-agent",
    summarizeCalls: 0,
    async review() {
      return [];
    },
    async summarize() {
      this.summarizeCalls += 1;
      return `understanding #${this.summarizeCalls}`;
    },
  };
}

test("ProjectInsightService: generates, caches within TTL, regenerates after", async () => {
  const { repo, r } = await seedRepo();
  const engine = summarizingEngine();
  const service = new ProjectInsightService(repo, { ttlMs: 1000, now: () => T0 });

  // First call → generates and persists.
  const first = await service.ensure(engine, r, ctx());
  assert.equal(first, "understanding #1");
  assert.equal(engine.summarizeCalls, 1);
  assert.equal((await repo.getRepoInsight(r.id))?.summary, "understanding #1");

  // Within TTL → served from cache, no new generation.
  const cached = await service.ensure(engine, r, ctx());
  assert.equal(cached, "understanding #1");
  assert.equal(engine.summarizeCalls, 1);

  // Past TTL → regenerates.
  const stale = new ProjectInsightService(repo, { ttlMs: 1000, now: () => T0 + 2000 });
  const regen = await stale.ensure(engine, r, ctx());
  assert.equal(regen, "understanding #2");
  assert.equal(engine.summarizeCalls, 2);
});

test("ProjectInsightService: no-op for engines that can't summarize", async () => {
  const { repo, r } = await seedRepo();
  const engine: ReviewEngine = {
    kind: "mock",
    async review() {
      return [];
    },
  };
  const service = new ProjectInsightService(repo, { ttlMs: 1000, now: () => T0 });
  assert.equal(await service.ensure(engine, r, ctx()), undefined);
  assert.equal(await repo.getRepoInsight(r.id), null);
});
