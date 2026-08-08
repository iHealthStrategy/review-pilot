import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { startAppServer } from "../src/app.js";
import type { Platform } from "../src/domain/entities.js";
import { MemoryRepository } from "../src/persistence/memory-repository.js";
import type { Repository } from "../src/persistence/repository.js";
import { TaskService } from "../src/trigger/trigger-service.js";
import { makeSession } from "./auth-helper.js";
import { fixedClock, seqIdGen } from "./repository-contract.js";
import { SpyProvider } from "./spy-provider.js";

const SECRET = "test-session-secret";

async function withApi(run: (base: string, repo: Repository) => Promise<void>): Promise<void> {
  const repo = new MemoryRepository({ clock: fixedClock(), idGen: seqIdGen() });
  await repo.init();
  const taskService = new TaskService({
    repo,
    providerFor: (_p: Platform) => new SpyProvider(),
    defaultEngine: "mock",
    enabledEngines: ["mock"],
  });
  const server = startAppServer({ repo, taskService, sessionSecret: SECRET }, 0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(base, repo);
  } finally {
    server.close();
  }
}

async function viewerToken(repo: Repository): Promise<string> {
  return (await makeSession(repo, SECRET, "viewer")).token;
}

async function seed(repo: Repository) {
  await repo.recordTokenUsage({
    source: "schedule", sourceId: "sch_1", sourceLabel: "nightly", engine: "claude-agent",
    inputTokens: 100, outputTokens: 40, estimated: false, at: "2026-06-22T08:00:00.000Z",
  });
  await repo.recordTokenUsage({
    source: "schedule", sourceId: "sch_1", sourceLabel: "nightly", engine: "claude-agent",
    inputTokens: 60, outputTokens: 20, estimated: true, at: "2026-06-22T20:00:00.000Z",
  });
  await repo.recordTokenUsage({
    source: "task", sourceId: "acme/app", sourceLabel: "acme/app", engine: "claude-code",
    inputTokens: 30, outputTokens: 10, estimated: true, at: "2026-06-22T09:00:00.000Z",
  });
}

test("GET /api/usage requires auth", () =>
  withApi(async (base) => {
    assert.equal((await fetch(`${base}/api/usage`)).status, 401);
  }));

test("GET /api/usage aggregates by day and is readable by a viewer", () =>
  withApi(async (base, repo) => {
    await seed(repo);
    const token = await viewerToken(repo);
    const res = await fetch(`${base}/api/usage?bucket=day`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { bucket: string; rows: any[] };
    assert.equal(body.bucket, "day");
    // Two distinct (source,sourceId) groups on the same day.
    const sched = body.rows.find((r) => r.source === "schedule" && r.sourceId === "sch_1");
    assert.ok(sched);
    assert.equal(sched.runs, 2);
    assert.equal(sched.totalTokens, 220); // (100+40)+(60+20)
    assert.equal(sched.estimated, true); // one of the two was estimated
    const task = body.rows.find((r) => r.source === "task");
    assert.equal(task.totalTokens, 40);
  }));

test("GET /api/usage?source=task filters to tasks only", () =>
  withApi(async (base, repo) => {
    await seed(repo);
    const token = await viewerToken(repo);
    const res = await fetch(`${base}/api/usage?bucket=month&source=task`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as { rows: any[] };
    assert.ok(body.rows.length >= 1);
    assert.ok(body.rows.every((r) => r.source === "task"));
  }));

// --- Skill usage upload + per-user visibility ---

function postSkill(base: string, token: string, body: unknown) {
  return fetch(`${base}/api/usage/skill`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("POST /api/usage/skill requires auth", () =>
  withApi(async (base) => {
    const res = await fetch(`${base}/api/usage/skill`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "working" }),
    });
    assert.equal(res.status, 401);
  }));

test("POST /api/usage/skill records a run attributed to the caller", () =>
  withApi(async (base, repo) => {
    const u = await makeSession(repo, SECRET, "viewer");
    const res = await postSkill(base, u.token, {
      project: "github.com/acme/app",
      scope: "working",
      critical: 1,
      major: 2,
      minor: 0,
      info: 5,
    });
    assert.equal(res.status, 201);
  }));

test("GET /api/usage/skill: admin sees all users, others see only themselves", () =>
  withApi(async (base, repo) => {
    const admin = await makeSession(repo, SECRET, "admin");
    const dev = await makeSession(repo, SECRET, "viewer");
    await postSkill(base, dev.token, { project: "p", scope: "working", critical: 1, major: 0, minor: 0, info: 0 });
    await postSkill(base, dev.token, { project: "p", scope: "branch", critical: 0, major: 1, minor: 0, info: 0 });
    await postSkill(base, admin.token, { project: "p", scope: "whole", critical: 0, major: 0, minor: 3, info: 0 });

    const asAdmin = (await (
      await fetch(`${base}/api/usage/skill?bucket=month`, { headers: { authorization: `Bearer ${admin.token}` } })
    ).json()) as { scope: string; rows: any[] };
    assert.equal(asAdmin.scope, "all");
    assert.equal(asAdmin.rows.length, 2, "admin sees both users");
    const devRow = asAdmin.rows.find((r) => r.userId === dev.user.id);
    assert.equal(devRow.runs, 2);
    assert.equal(devRow.findings, 2); // 1 critical + 1 major across the two runs
    assert.equal(devRow.critical, 1);
    assert.equal(devRow.major, 1);

    const asDev = (await (
      await fetch(`${base}/api/usage/skill?bucket=month`, { headers: { authorization: `Bearer ${dev.token}` } })
    ).json()) as { scope: string; rows: any[] };
    assert.equal(asDev.scope, "self");
    assert.equal(asDev.rows.length, 1, "non-admin sees only their own");
    assert.equal(asDev.rows[0].userId, dev.user.id);
  }));

// --- Review stats: findings + timings upload, and the admin-only views ---

test("POST /api/usage/skill stores findings and both timings", () =>
  withApi(async (base, repo) => {
    const u = await makeSession(repo, SECRET, "viewer");
    const res = await postSkill(base, u.token, {
      project: "https://github.com/Acme/App.git", // normalized server-side
      scope: "branch",
      critical: 0,
      major: 1,
      minor: 0,
      info: 1,
      durationMs: 300_000,
      activeMs: 120_000,
      findings: [
        {
          severity: "major",
          filePath: "src/db.ts",
          line: 42,
          title: "Unbounded query",
          detail: "Reads the whole table.",
          suggestion: "Paginate.",
          category: "performance",
        },
        { severity: "info", filePath: "", title: "No changelog entry" },
      ],
    });
    assert.equal(res.status, 201);
    const [run] = await repo.listSkillUsage();
    assert.equal(run!.project, "github.com/acme/app", "project key normalized");
    assert.equal(run!.durationMs, 300_000);
    assert.equal(run!.activeMs, 120_000);
    assert.equal(run!.findings.length, 2);
    assert.equal(run!.findings[0]!.line, 42);
    assert.equal(run!.findings[0]!.category, "performance");
    assert.equal(run!.findings[1]!.filePath, "", "repo-wide finding keeps an empty path");
  }));

test("POST /api/usage/skill stays backward compatible with counts-only reports", () =>
  withApi(async (base, repo) => {
    const u = await makeSession(repo, SECRET, "viewer");
    // Exactly what a skill installed before this feature sends.
    const res = await postSkill(base, u.token, {
      project: "p", scope: "working", critical: 0, major: 1, minor: 0, info: 0,
    });
    assert.equal(res.status, 201);
    const [run] = await repo.listSkillUsage();
    assert.equal(run!.durationMs, undefined, "absent, not zero");
    assert.equal(run!.activeMs, undefined);
    assert.deepEqual(run!.findings, []);
  }));

test("POST /api/usage/skill sanitizes a hostile payload instead of trusting it", () =>
  withApi(async (base, repo) => {
    const u = await makeSession(repo, SECRET, "viewer");
    const res = await postSkill(base, u.token, {
      project: "p",
      scope: "working",
      critical: 0, major: 0, minor: 0, info: 0,
      durationMs: -5, // negative → dropped
      activeMs: 999_999, // dropped too: the timing pair is all-or-nothing
      findings: [
        ...Array.from({ length: 250 }, () => ({ severity: "minor", filePath: "a.ts", title: "x" })),
        { severity: "bogus", filePath: "a.ts", title: "bad severity" }, // dropped
        { severity: "minor", filePath: "a.ts" }, // no title → dropped
        { severity: "minor", filePath: "a.ts", title: "y".repeat(500) }, // truncated
        "not an object",
      ],
    });
    assert.equal(res.status, 201);
    const [run] = await repo.listSkillUsage();
    assert.equal(run!.durationMs, undefined, "negative duration dropped");
    assert.equal(run!.activeMs, undefined, "no duration → no active time either");
    assert.equal(run!.findings.length, 200, "array capped at SKILL_FINDING_LIMITS.maxFindings");
    assert.ok(run!.findings.every((f) => f.severity === "minor"));
    assert.ok(run!.findings.every((f) => f.title.length <= 300));
  }));

test("POST /api/usage/skill clamps activeMs to the reported duration", () =>
  withApi(async (base, repo) => {
    const u = await makeSession(repo, SECRET, "viewer");
    await postSkill(base, u.token, {
      project: "p", scope: "working", critical: 0, major: 0, minor: 0, info: 0,
      durationMs: 1000, activeMs: 9999,
    });
    const [run] = await repo.listSkillUsage();
    assert.equal(run!.activeMs, 1000, "active time can never exceed wall clock");
  }));

test("GET /api/usage/skill/projects and /runs are admin-only", () =>
  withApi(async (base, repo) => {
    const dev = await makeSession(repo, SECRET, "member");
    for (const path of ["/api/usage/skill/projects", "/api/usage/skill/runs"]) {
      assert.equal((await fetch(`${base}${path}`)).status, 401, `${path} anonymous`);
      assert.equal(
        (await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${dev.token}` } })).status,
        403,
        `${path} non-admin`,
      );
    }
  }));

test("GET /api/usage/skill/projects rolls findings up per project", () =>
  withApi(async (base, repo) => {
    const admin = await makeSession(repo, SECRET, "admin");
    const dev = await makeSession(repo, SECRET, "viewer");
    const finding = { severity: "major", filePath: "src/db.ts", title: "Unbounded query" };
    await postSkill(base, dev.token, {
      project: "github.com/acme/app", scope: "branch",
      critical: 0, major: 1, minor: 0, info: 0, findings: [finding],
    });
    await postSkill(base, admin.token, {
      project: "github.com/acme/app", scope: "branch",
      critical: 0, major: 1, minor: 0, info: 0,
      findings: [{ ...finding, filePath: "src/other.ts" }],
    });
    const body = (await (
      await fetch(`${base}/api/usage/skill/projects?bucket=month`, {
        headers: { authorization: `Bearer ${admin.token}` },
      })
    ).json()) as { rows: any[] };
    const app = body.rows.find((r) => r.project === "github.com/acme/app");
    assert.equal(app.runs, 2);
    assert.equal(app.reviewers, 2);
    assert.equal(app.problems.length, 1, "same problem across two runs collapses");
    assert.equal(app.problems[0].count, 2);
    assert.deepEqual(app.problems[0].files.sort(), ["src/db.ts", "src/other.ts"]);

    // ?project= narrows to one project.
    const one = (await (
      await fetch(`${base}/api/usage/skill/projects?bucket=month&project=github.com/nope/x`, {
        headers: { authorization: `Bearer ${admin.token}` },
      })
    ).json()) as { rows: any[] };
    assert.equal(one.rows.length, 0);
  }));

test("GET /api/usage/skill/runs returns raw runs with findings, newest first, capped", () =>
  withApi(async (base, repo) => {
    const admin = await makeSession(repo, SECRET, "admin");
    for (const scope of ["working", "branch", "whole"]) {
      await postSkill(base, admin.token, {
        project: "github.com/acme/app", scope,
        critical: 0, major: 1, minor: 0, info: 0,
        durationMs: 60_000, activeMs: 30_000,
        findings: [{ severity: "major", filePath: `src/${scope}.ts`, title: "Issue" }],
      });
    }
    const body = (await (
      await fetch(`${base}/api/usage/skill/runs?bucket=month&limit=2`, {
        headers: { authorization: `Bearer ${admin.token}` },
      })
    ).json()) as { limit: number; runs: any[] };
    assert.equal(body.limit, 2);
    assert.equal(body.runs.length, 2, "limit respected");
    assert.ok(body.runs[0].at >= body.runs[1].at, "newest first");
    assert.equal(body.runs[0].findings.length, 1);
    assert.equal(body.runs[0].activeMs, 30_000);
  }));

test("GET /api/usage/skill resolves a readable display name, not the long handle", () =>
  withApi(async (base, repo) => {
    // An OIDC-provisioned account often has a 64-char opaque subject as its
    // handle, which makes the stored `@handle` label unusable as a table column.
    const long = "d".repeat(64);
    const admin = await makeSession(repo, SECRET, "admin", { handle: long, name: "黄毅" });
    await postSkill(base, admin.token, {
      project: "p", scope: "working", critical: 0, major: 1, minor: 0, info: 0,
      findings: [{ severity: "major", filePath: "a.ts", title: "x" }],
    });

    const byUser = (await (
      await fetch(`${base}/api/usage/skill?bucket=month`, { headers: { authorization: `Bearer ${admin.token}` } })
    ).json()) as { rows: any[] };
    assert.equal(byUser.rows[0].userName, "黄毅", "IdP display name is surfaced");
    assert.match(byUser.rows[0].userLabel, /^@d{64}$/, "the stored label is untouched");

    // The raw-run view needs it too — it shows one row per review.
    const runs = (await (
      await fetch(`${base}/api/usage/skill/runs?bucket=month`, { headers: { authorization: `Bearer ${admin.token}` } })
    ).json()) as { runs: any[] };
    assert.equal(runs.runs[0].userName, "黄毅");
    // Findings still ride along — enriching must not drop the run's payload.
    assert.equal(runs.runs[0].findings.length, 1);
  }));

test("GET /api/usage/skill falls back when the IdP gave no name", () =>
  withApi(async (base, repo) => {
    const u = await makeSession(repo, SECRET, "admin", {
      handle: "alice", name: "", email: "alice@x.com",
    });
    await postSkill(base, u.token, { project: "p", scope: "working", critical: 0, major: 0, minor: 1, info: 0 });
    const byUser = (await (
      await fetch(`${base}/api/usage/skill?bucket=month`, { headers: { authorization: `Bearer ${u.token}` } })
    ).json()) as { rows: any[] };
    assert.equal(byUser.rows[0].userName, "alice@x.com", "no name → real email");
  }));

test("POST /api/usage/skill accepts change size, fix counts and the change key", () =>
  withApi(async (base, repo) => {
    const u = await makeSession(repo, SECRET, "member");
    await postSkill(base, u.token, {
      project: "p", scope: "working", critical: 0, major: 1, minor: 0, info: 0,
      filesChanged: 3, linesChanged: 128,
      fixesProposed: 4, fixesApplied: 3,
      changeKey: "abc123:working",
    });
    const [run] = await repo.listSkillUsage();
    assert.equal(run!.filesChanged, 3);
    assert.equal(run!.linesChanged, 128);
    assert.equal(run!.fixesProposed, 4);
    assert.equal(run!.fixesApplied, 3);
    assert.equal(run!.changeKey, "abc123:working");
  }));

test("POST /api/usage/skill clamps applied fixes to proposed, drops bogus counts", () =>
  withApi(async (base, repo) => {
    const u = await makeSession(repo, SECRET, "member");
    await postSkill(base, u.token, {
      project: "p", scope: "working", critical: 0, major: 0, minor: 0, info: 0,
      fixesProposed: 2, fixesApplied: 99, // an adoption rate over 100% is nonsense
      filesChanged: -4, // negative → dropped, not stored as a bogus size
      changeKey: "   ", // blank → no key at all, so it counts as its own change
    });
    const [run] = await repo.listSkillUsage();
    assert.equal(run!.fixesApplied, 2);
    assert.equal(run!.filesChanged, undefined);
    assert.equal(run!.changeKey, undefined);
  }));

test("GET /api/usage/skill reports the first-pass rate and rule contribution", () =>
  withApi(async (base, repo) => {
    const u = await makeSession(repo, SECRET, "admin", { name: "Dev" });
    // One change that failed then passed, one that passed immediately.
    const post = (extra: Record<string, unknown>) =>
      postSkill(base, u.token, { project: "p", scope: "working", critical: 0, major: 0, minor: 0, info: 0, ...extra });
    await post({ changeKey: "c1", major: 2 });
    await post({ changeKey: "c1" });
    await post({ changeKey: "c2" });
    // A ruleset the user owns: one rule has earned a hit, one hasn't, one is off.
    await fetch(`${base}/api/rulesets`, {
      method: "POST",
      headers: { authorization: `Bearer ${u.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "mine", visibility: "private",
        rules: [
          { title: "hit", instruction: "x", globs: [], languages: [], topics: [], hits: 3 },
          { title: "cold", instruction: "x", globs: [], languages: [], topics: [] },
          { title: "off", instruction: "x", globs: [], languages: [], topics: [], disabled: true },
        ],
      }),
    });

    const body = (await (
      await fetch(`${base}/api/usage/skill?bucket=month`, { headers: { authorization: `Bearer ${u.token}` } })
    ).json()) as { rows: any[] };
    const r = body.rows[0];
    assert.equal(r.runs, 3);
    assert.equal(r.changesReviewed, 2, "three runs, two changes");
    assert.equal(r.cleanFirstPass, 1);
    assert.equal(r.firstPassRate, 0.5);
    assert.equal(r.rulesOwned, 2, "disabled rules are not a contribution");
    assert.equal(r.rulesHit, 1);
    assert.equal(r.userName, "Dev");
  }));
