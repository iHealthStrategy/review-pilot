import assert from "node:assert/strict";
import { test } from "node:test";
import { InvalidTransitionError } from "../src/domain/state-machine.js";
import {
  EntityNotFoundError,
  type Clock,
  type IdGen,
  type Repository,
} from "../src/persistence/repository.js";

/** Deterministic clock: ISO timestamps advancing one second per call. */
export function fixedClock(): Clock {
  let t = Date.parse("2026-01-01T00:00:00.000Z");
  return () => {
    const iso = new Date(t).toISOString();
    t += 1000;
    return iso;
  };
}

/** Deterministic ids: `<prefix>_<n>` counting per prefix. */
export function seqIdGen(): IdGen {
  const counters = new Map<string, number>();
  return (prefix) => {
    const n = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, n);
    return `${prefix}_${n}`;
  };
}

async function seedJob(repo: Repository) {
  const project = await repo.createProject({
    name: "demo",
    platform: "github",
    defaultEngine: "mock",
    enabledEngines: ["mock", "claude-code"],
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
  const job = await repo.createReviewJob({
    pullRequestId: pr.id,
    engine: "mock",
  });
  return { project, repo: r, pr, job };
}

/**
 * Behavioural contract every {@link Repository} backend must satisfy. Each
 * backend registers the same suite, guaranteeing the persistence driver is
 * switchable without behavioural drift.
 */
export function runRepositoryContract(
  name: string,
  makeRepo: () => Promise<Repository>,
): void {
  test(`${name}: create & read back a project`, async () => {
    const repo = await makeRepo();
    const created = await repo.createProject({
      name: "p1",
      platform: "gitlab",
      defaultEngine: "claude-code",
      enabledEngines: ["claude-code", "codex"],
    });
    const fetched = await repo.getProject(created.id);
    assert.deepEqual(fetched, created);
    assert.deepEqual(await repo.listProjects(), [created]);
    await repo.close();
  });

  test(`${name}: repo requires an existing project`, async () => {
    const repo = await makeRepo();
    await assert.rejects(
      repo.createRepo({
        projectId: "missing",
        platform: "github",
        fullName: "x/y",
        remoteUrl: "x",
        cloneUrl: "x",
        defaultBranch: "main",
      }),
      EntityNotFoundError,
    );
    await repo.close();
  });

  test(`${name}: findRepoByFullName matches platform + full path`, async () => {
    const repo = await makeRepo();
    const { repo: r } = await seedJob(repo);
    const found = await repo.findRepoByFullName("github", "acme/demo");
    assert.equal(found?.id, r.id);
    assert.equal(found?.fullName, "acme/demo");
    // Platform must also match.
    assert.equal(await repo.findRepoByFullName("gitlab", "acme/demo"), null);
    assert.equal(await repo.findRepoByFullName("github", "nope/none"), null);
    assert.equal((await repo.listRepos()).length, 1);
    await repo.close();
  });

  test(`${name}: upsertPullRequest dedupes by (repoId, number)`, async () => {
    const repo = await makeRepo();
    const { repo: r } = await seedJob(repo);
    const before = (await repo.listReviewJobs()).length;
    const again = await repo.upsertPullRequest({
      repoId: r.id,
      number: 7,
      title: "Add feature (edited)",
      sourceBranch: "feat",
      targetBranch: "main",
      headSha: "def456",
      author: "alice",
      url: "https://github.com/acme/demo/pull/7",
      state: "open",
    });
    assert.equal(again.title, "Add feature (edited)");
    assert.equal(again.headSha, "def456");
    const found = await repo.findPullRequest(r.id, 7);
    assert.equal(found?.id, again.id);
    // No duplicate PR row was created.
    assert.equal(before, 1);
    await repo.close();
  });

  test(`${name}: review job happy-path state flow`, async () => {
    const repo = await makeRepo();
    const { job } = await seedJob(repo);
    assert.equal(job.status, "pending");
    assert.equal(job.attempts, 0);

    const running = await repo.transitionReviewJob(job.id, "running", {
      progress: 10,
    });
    assert.equal(running.status, "running");
    assert.equal(running.attempts, 1);
    assert.equal(running.progress, 10);
    assert.ok(running.startedAt);

    const done = await repo.transitionReviewJob(job.id, "succeeded", {
      progress: 100,
    });
    assert.equal(done.status, "succeeded");
    assert.equal(done.progress, 100);
    assert.ok(done.finishedAt);
    await repo.close();
  });

  test(`${name}: illegal transition is rejected`, async () => {
    const repo = await makeRepo();
    const { job } = await seedJob(repo);
    await assert.rejects(
      repo.transitionReviewJob(job.id, "succeeded"),
      InvalidTransitionError,
    );
    await repo.close();
  });

  test(`${name}: failed job can be requeued and retried`, async () => {
    const repo = await makeRepo();
    const { job } = await seedJob(repo);
    await repo.transitionReviewJob(job.id, "running");
    await repo.transitionReviewJob(job.id, "failed", { error: "boom" });
    const failed = await repo.getReviewJob(job.id);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.error, "boom");

    const requeued = await repo.transitionReviewJob(job.id, "pending");
    assert.equal(requeued.status, "pending");
    const retried = await repo.transitionReviewJob(job.id, "running");
    assert.equal(retried.attempts, 2);
    await repo.close();
  });

  test(`${name}: claimNextPendingJob atomically takes the oldest pending job`, async () => {
    const repo = await makeRepo();
    const { job } = await seedJob(repo);
    const claimed = await repo.claimNextPendingJob();
    assert.equal(claimed?.id, job.id);
    assert.equal(claimed?.status, "running");
    assert.equal(claimed?.attempts, 1);
    assert.ok(claimed?.startedAt);
    // Queue is now empty → a second claim returns null.
    assert.equal(await repo.claimNextPendingJob(), null);
    await repo.close();
  });

  test(`${name}: append logs and list by filter`, async () => {
    const repo = await makeRepo();
    const { job } = await seedJob(repo);
    await repo.appendJobLog(job.id, "cloning repo");
    await repo.appendJobLog(job.id, "running engine");
    const fetched = await repo.getReviewJob(job.id);
    assert.deepEqual(fetched?.logs, ["cloning repo", "running engine"]);

    await repo.transitionReviewJob(job.id, "running");
    assert.equal((await repo.listReviewJobs({ status: "running" })).length, 1);
    assert.equal((await repo.listReviewJobs({ status: "pending" })).length, 0);
    assert.equal(
      (await repo.listReviewJobs({ pullRequestId: job.pullRequestId })).length,
      1,
    );
    await repo.close();
  });

  test(`${name}: repo insight upserts and reads back (one per repo)`, async () => {
    const repo = await makeRepo();
    const { repo: r } = await seedJob(repo);
    assert.equal(await repo.getRepoInsight(r.id), null);

    const first = await repo.upsertRepoInsight({
      repoId: r.id,
      summary: "monorepo; server in packages/server",
      headSha: "abc123",
    });
    assert.equal(first.summary, "monorepo; server in packages/server");
    assert.ok(first.updatedAt);
    assert.equal((await repo.getRepoInsight(r.id))?.headSha, "abc123");

    // Upsert replaces (still one per repo).
    const second = await repo.upsertRepoInsight({
      repoId: r.id,
      summary: "updated understanding",
      headSha: "def456",
    });
    assert.equal(second.summary, "updated understanding");
    const fetched = await repo.getRepoInsight(r.id);
    assert.equal(fetched?.summary, "updated understanding");
    assert.equal(fetched?.headSha, "def456");
    await repo.close();
  });

  test(`${name}: add & list structured findings`, async () => {
    const repo = await makeRepo();
    const { job } = await seedJob(repo);
    const created = await repo.addFindings(job.id, [
      {
        filePath: "src/a.ts",
        line: 12,
        severity: "major",
        title: "Possible null deref",
        detail: "x may be undefined",
        suggestion: "guard with ?.",
        category: "correctness",
      },
      {
        filePath: "src/b.ts",
        severity: "info",
        title: "Naming",
        detail: "prefer camelCase",
      },
    ]);
    assert.equal(created.length, 2);
    const listed = await repo.listFindings(job.id);
    assert.equal(listed.length, 2);
    const major = listed.find((f) => f.severity === "major");
    assert.equal(major?.line, 12);
    assert.equal(major?.suggestion, "guard with ?.");
    const info = listed.find((f) => f.severity === "info");
    assert.equal(info?.line, undefined);
    await repo.close();
  });

  test(`${name}: users — create, fetch by id/email, count, role update`, async () => {
    const repo = await makeRepo();
    assert.equal(await repo.countUsers(), 0);
    const u = await repo.createUser({ email: "a@x.com", passwordHash: "h1", role: "admin" });
    assert.equal(u.role, "admin");
    assert.equal((await repo.getUserById(u.id))?.email, "a@x.com");
    assert.equal((await repo.getUserByEmail("a@x.com"))?.id, u.id);
    assert.equal(await repo.getUserByEmail("missing@x.com"), null);
    assert.equal(await repo.countUsers(), 1);
    const upgraded = await repo.updateUserRole(u.id, "member");
    assert.equal(upgraded.role, "member");
    assert.equal((await repo.getUserById(u.id))?.role, "member");
    await repo.close();
  });

  test(`${name}: api tokens — create, lookup by hash, list, owner-scoped revoke`, async () => {
    const repo = await makeRepo();
    const u = await repo.createUser({ email: "t@x.com", passwordHash: "h", role: "member" });
    const tok = await repo.createApiToken({
      userId: u.id,
      name: "ci",
      tokenHash: "hash-1",
      prefix: "rpat_ab12",
    });
    assert.equal((await repo.getApiTokenByHash("hash-1"))?.id, tok.id);
    assert.equal(await repo.getApiTokenByHash("nope"), null);
    assert.deepEqual((await repo.listApiTokensByUser(u.id)).map((t) => t.id), [tok.id]);

    await repo.touchApiToken(tok.id, "2026-01-01T00:00:00Z");
    assert.equal((await repo.getApiTokenByHash("hash-1"))?.lastUsedAt, "2026-01-01T00:00:00Z");

    // Revoke is scoped to the owner: a different user's delete is a no-op.
    await repo.deleteApiToken(tok.id, "someone-else");
    assert.ok(await repo.getApiTokenByHash("hash-1"));
    await repo.deleteApiToken(tok.id, u.id);
    assert.equal(await repo.getApiTokenByHash("hash-1"), null);
    assert.equal((await repo.listApiTokensByUser(u.id)).length, 0);
    await repo.close();
  });

  test(`${name}: token usage — record, total, and filter by source/since`, async () => {
    const repo = await makeRepo();
    const a = await repo.recordTokenUsage({
      source: "schedule",
      sourceId: "sch_1",
      sourceLabel: "nightly",
      engine: "claude-agent",
      inputTokens: 100,
      outputTokens: 40,
      estimated: false,
      at: "2026-06-20T10:00:00.000Z",
    });
    assert.equal(a.totalTokens, 140, "total = input + output");
    await repo.recordTokenUsage({
      source: "task",
      sourceId: "acme/app",
      sourceLabel: "acme/app",
      engine: "claude-code",
      inputTokens: 50,
      outputTokens: 10,
      estimated: true,
      at: "2026-06-22T10:00:00.000Z",
    });

    const all = await repo.listTokenUsage();
    assert.equal(all.length, 2);
    assert.ok(all[0]!.at >= all[1]!.at, "newest first");

    assert.equal((await repo.listTokenUsage({ source: "schedule" })).length, 1);
    assert.equal((await repo.listTokenUsage({ sourceId: "acme/app" }))[0]!.estimated, true);
    assert.equal((await repo.listTokenUsage({ since: "2026-06-21T00:00:00.000Z" })).length, 1);
    await repo.close();
  });

  test(`${name}: rulesets — owner-scoped CRUD + public listing`, async () => {
    const repo = await makeRepo();
    const mk = (ownerId: string, name2: string, visibility: "private" | "public") =>
      repo.createRuleset({
        ownerId,
        ownerEmail: ownerId + "@x.com",
        name: name2,
        slug: name2.toLowerCase(),
        description: "d",
        visibility,
        language: "中文",
        focus: "perf",
        instructions: "be strict",
      });

    const a = await mk("u1", "Strict", "public");
    await mk("u1", "Loose", "private");
    await mk("u2", "Other", "public");

    assert.equal((await repo.listRulesetsByOwner("u1")).length, 2);
    assert.equal((await repo.listPublicRulesets()).length, 2); // Strict + Other
    assert.equal((await repo.getRuleset(a.id))?.name, "Strict");

    const upd = await repo.updateRuleset(a.id, "u1", { focus: "security", visibility: "private" });
    assert.equal(upd.focus, "security");
    assert.equal((await repo.listPublicRulesets()).length, 1); // Strict now private

    // Update/delete by a non-owner is a no-op / not-found.
    await assert.rejects(() => repo.updateRuleset(a.id, "u2", { focus: "x" }));
    await repo.deleteRuleset(a.id, "u2");
    assert.ok(await repo.getRuleset(a.id), "non-owner delete is a no-op");
    await repo.deleteRuleset(a.id, "u1");
    assert.equal(await repo.getRuleset(a.id), null);
    await repo.close();
  });
}
