import assert from "node:assert/strict";
import { test } from "node:test";
import type { SkillFinding, SkillUsage, TokenUsage } from "../src/domain/entities.js";
import {
  aggregateSkillByProject,
  aggregateSkillByUser,
  aggregateUsage,
  bucketKey,
  defaultSince,
  percentile,
  bucketForRange,
  isRange,
  sinceForRange,
  type Range,
} from "../src/usage/aggregate.js";

function ev(p: Partial<TokenUsage> = {}): TokenUsage {
  return {
    id: "u",
    source: "schedule",
    sourceId: "s1",
    sourceLabel: "S1",
    engine: "mock",
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    estimated: false,
    at: "2026-06-22T10:00:00.000Z",
    ...p,
  };
}

test("bucketKey: day/month are slices; week is the UTC Monday", () => {
  assert.equal(bucketKey("2026-06-22T10:00:00.000Z", "day"), "2026-06-22");
  assert.equal(bucketKey("2026-06-22T10:00:00.000Z", "month"), "2026-06");
  const wk = bucketKey("2026-06-22T10:00:00.000Z", "week");
  // The key is a Monday, and two days in the same week share it.
  assert.equal(new Date(wk).getUTCDay(), 1);
  assert.equal(bucketKey("2026-06-25T23:00:00.000Z", "week"), wk);
  assert.notEqual(bucketKey("2026-06-29T00:00:00.000Z", "week"), wk); // next week
});

test("aggregateUsage: sums per (source, sourceId, bucket) and counts runs", () => {
  const rows = aggregateUsage(
    [
      ev({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
      ev({ inputTokens: 20, outputTokens: 10, totalTokens: 30 }),
    ],
    "day",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.runs, 2);
  assert.equal(rows[0]!.inputTokens, 30);
  assert.equal(rows[0]!.outputTokens, 15);
  assert.equal(rows[0]!.totalTokens, 45);
  assert.equal(rows[0]!.estimated, false);
});

test("aggregateUsage: estimated is true if ANY contributing record is estimated", () => {
  const rows = aggregateUsage([ev({ estimated: false }), ev({ estimated: true })], "day");
  assert.equal(rows[0]!.estimated, true);
});

test("aggregateUsage: splits by source and by bucket, newest bucket first", () => {
  const rows = aggregateUsage(
    [
      ev({ source: "schedule", sourceId: "s1", at: "2026-06-21T10:00:00Z" }),
      ev({ source: "task", sourceId: "acme/app", at: "2026-06-22T10:00:00Z" }),
      ev({ source: "task", sourceId: "acme/app", at: "2026-06-22T12:00:00Z" }),
    ],
    "day",
  );
  // Two groups: (schedule, s1, 06-21) and (task, acme/app, 06-22 — two merged).
  assert.equal(rows.length, 2);
  // Newest bucket first.
  assert.equal(rows[0]!.bucket, "2026-06-22");
  const app = rows.find((r) => r.sourceId === "acme/app");
  assert.equal(app!.runs, 2);
  assert.equal(app!.source, "task");
});

test("defaultSince: wider window for coarser buckets", () => {
  const now = Date.parse("2026-06-22T00:00:00.000Z");
  assert.ok(defaultSince("day", now) > defaultSince("week", now));
  assert.ok(defaultSince("week", now) > defaultSince("month", now));
});

// --- Skill review stats -----------------------------------------------------

function sk(p: Partial<SkillUsage> = {}): SkillUsage {
  return {
    id: "sku",
    userId: "usr_a",
    userLabel: "@alice",
    project: "github.com/acme/app",
    scope: "branch",
    critical: 0,
    major: 0,
    minor: 0,
    info: 0,
    findings: [],
    at: "2026-06-22T10:00:00.000Z",
    ...p,
  };
}
function fnd(p: Partial<SkillFinding> = {}): SkillFinding {
  return { severity: "major", filePath: "src/a.ts", title: "Unbounded query", ...p };
}

test("aggregateSkillByUser: averages timing over ONLY the runs that reported it", () => {
  const [row] = aggregateSkillByUser([
    sk({ major: 1, durationMs: 300_000, activeMs: 100_000 }),
    sk({ major: 1, durationMs: 100_000, activeMs: 60_000 }),
    sk({ minor: 2 }), // counts-only run: must not drag the averages toward zero
  ]);
  assert.equal(row!.runs, 3);
  assert.equal(row!.timedRuns, 2);
  assert.equal(row!.avgDurationMs, 200_000);
  assert.equal(row!.avgActiveMs, 80_000);
  assert.equal(row!.findings, 4); // 1 + 1 + 2
});

test("aggregateSkillByUser: a run with duration but no activeMs counts as all-active", () => {
  const [row] = aggregateSkillByUser([sk({ durationMs: 50_000 })]);
  assert.equal(row!.timedRuns, 1);
  assert.equal(row!.avgActiveMs, 50_000, "no waits to subtract → active == duration");
});

test("aggregateSkillByUser: no timing anywhere leaves the averages at zero", () => {
  const [row] = aggregateSkillByUser([sk({ major: 1 }), sk({ minor: 1 })]);
  assert.equal(row!.timedRuns, 0);
  assert.equal(row!.avgDurationMs, 0);
  assert.equal(row!.avgActiveMs, 0);
});

test("aggregateSkillByProject: collapses the same problem across runs and files", () => {
  const rows = aggregateSkillByProject([
    sk({
      major: 2,
      findings: [fnd(), fnd({ filePath: "src/b.ts" })],
    }),
    sk({
      userId: "usr_b",
      major: 1,
      // Same problem, differently cased title → still one row.
      findings: [fnd({ title: "unbounded QUERY", filePath: "src/c.ts" })],
    }),
    sk({ project: "github.com/acme/other", info: 1, findings: [fnd({ severity: "info", title: "No changelog" })] }),
  ]);
  assert.equal(rows.length, 2);
  const app = rows.find((r) => r.project === "github.com/acme/app")!;
  assert.equal(app.runs, 2);
  assert.equal(app.reviewers, 2, "distinct users");
  assert.equal(app.problems.length, 1, "one recurring problem, not three");
  assert.equal(app.problems[0]!.count, 3);
  assert.deepEqual(app.problems[0]!.files.sort(), ["src/a.ts", "src/b.ts", "src/c.ts"]);
  // Sorted by total findings desc, so the busier project leads.
  assert.equal(rows[0]!.project, "github.com/acme/app");
});

test("aggregateSkillByProject: counts-only runs still count, with no problems", () => {
  const [row] = aggregateSkillByProject([sk({ minor: 3 })]);
  assert.equal(row!.runs, 1);
  assert.equal(row!.findings, 3);
  assert.deepEqual(row!.problems, []);
});

test("aggregateSkillByProject: caps the problem list and the per-problem file list", () => {
  const many = Array.from({ length: 30 }, (_, i) => fnd({ title: `Problem ${i}`, filePath: `src/f${i}.ts` }));
  const [row] = aggregateSkillByProject([sk({ major: 30, findings: many })], { topProblems: 5, maxFiles: 2 });
  assert.equal(row!.problems.length, 5);
  const spread = Array.from({ length: 6 }, (_, i) => fnd({ filePath: `src/g${i}.ts` }));
  const [row2] = aggregateSkillByProject([sk({ findings: spread })], { maxFiles: 2 });
  assert.equal(row2!.problems[0]!.count, 6);
  assert.equal(row2!.problems[0]!.files.length, 2, "file list capped");
});

// --- First-pass rate & the other per-user metrics ----------------------------

test("percentile: nearest-rank, no invented values", () => {
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile([7], 50), 7);
  assert.equal(percentile([7], 90), 7);
  // p50 of 1..10 is the 5th value; p90 the 9th. Never an interpolated 5.5.
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
  assert.equal(percentile([10, 1, 5], 50), 5, "sorts first");
});

test("firstPassRate: counts CHANGES, and only the change's first review", () => {
  // One change reviewed three times: dirty → dirty → clean. The change did NOT
  // pass first time, and the two extra runs are a consequence of that failure —
  // counting per run would both dilute and double-punish it.
  const rows = aggregateSkillByUser([
    sk({ id: "1", changeKey: "abc:working", major: 2, at: "2026-08-01T10:00:00.000Z" }),
    sk({ id: "2", changeKey: "abc:working", major: 1, at: "2026-08-01T10:10:00.000Z" }),
    sk({ id: "3", changeKey: "abc:working", at: "2026-08-01T10:20:00.000Z" }),
    // A second change that passed immediately.
    sk({ id: "4", changeKey: "def:branch", at: "2026-08-02T10:00:00.000Z" }),
  ]);
  const r = rows[0]!;
  assert.equal(r.runs, 4);
  assert.equal(r.changesReviewed, 2, "two distinct changes");
  assert.equal(r.cleanFirstPass, 1, "only 'def' was clean on its first review");
  assert.equal(r.firstPassRate, 0.5);
});

test("firstPassRate: 'clean' means no major/critical, matching the merge gate", () => {
  const rows = aggregateSkillByUser([
    sk({ id: "1", changeKey: "a", minor: 5, info: 9 }), // noisy but nothing blocking
    sk({ id: "2", changeKey: "b", critical: 1 }),
    sk({ id: "3", changeKey: "c", major: 1 }),
  ]);
  const r = rows[0]!;
  assert.equal(r.changesReviewed, 3);
  assert.equal(r.cleanFirstPass, 1, "minor/info do not block a merge, so they still pass");
  assert.equal(Number(r.firstPassRate.toFixed(4)), 0.3333);
});

test("firstPassRate: runs without a changeKey each count as their own change", () => {
  // Older skills report no key, so they must not all collapse into one change.
  const rows = aggregateSkillByUser([
    sk({ id: "1", major: 1 }),
    sk({ id: "2" }),
    sk({ id: "3" }),
  ]);
  const r = rows[0]!;
  assert.equal(r.changesReviewed, 3);
  assert.equal(r.cleanFirstPass, 2);
});

test("firstPassRate: earliest run wins regardless of arrival order", () => {
  const rows = aggregateSkillByUser([
    sk({ id: "late", changeKey: "a", at: "2026-08-01T12:00:00.000Z" }),
    sk({ id: "early", changeKey: "a", major: 3, at: "2026-08-01T09:00:00.000Z" }),
  ]);
  assert.equal(rows[0]!.cleanFirstPass, 0, "the 09:00 run is the first pass, and it failed");
});

test("aggregateSkillByUser: scope mix, breadth, active days and findings per run", () => {
  const rows = aggregateSkillByUser([
    sk({ id: "1", scope: "working", project: "p1", major: 2, at: "2026-08-01T01:00:00.000Z" }),
    sk({ id: "2", scope: "working", project: "p1", at: "2026-08-01T22:00:00.000Z" }),
    sk({ id: "3", scope: "branch", project: "p2", minor: 2, at: "2026-08-03T01:00:00.000Z" }),
  ]);
  const r = rows[0]!;
  assert.equal(r.scopeWorking, 2);
  assert.equal(r.scopeBranch, 1);
  assert.equal(r.scopeWhole, 0);
  assert.equal(r.projects, 2, "distinct projects");
  assert.equal(r.activeDays, 2, "two runs on 08-01 count as one day");
  assert.equal(Number(r.findingsPerRun.toFixed(4)), Number((4 / 3).toFixed(4)));
});

test("aggregateSkillByUser: percentiles and wait ratio over timed runs only", () => {
  const rows = aggregateSkillByUser([
    sk({ id: "1", durationMs: 100_000, activeMs: 50_000 }),
    sk({ id: "2", durationMs: 200_000, activeMs: 200_000 }),
    sk({ id: "3", durationMs: 900_000, activeMs: 100_000 }),
    sk({ id: "4" }), // untimed — must not enter the sample
  ]);
  const r = rows[0]!;
  assert.equal(r.timedRuns, 3);
  assert.equal(r.p50DurationMs, 200_000);
  assert.equal(r.p90DurationMs, 900_000);
  assert.equal(r.p50ActiveMs, 100_000);
  // 1.2M wall clock, 350k active → 850k waiting.
  assert.equal(Number(r.waitRatio.toFixed(4)), Number((850_000 / 1_200_000).toFixed(4)));
});

test("aggregateSkillByUser: change size and fix adoption", () => {
  const rows = aggregateSkillByUser([
    sk({ id: "1", filesChanged: 3, linesChanged: 120, fixesProposed: 4, fixesApplied: 4 }),
    sk({ id: "2", filesChanged: 1, linesChanged: 8, fixesProposed: 6, fixesApplied: 2 }),
    sk({ id: "3" }), // reports neither
  ]);
  const r = rows[0]!;
  assert.equal(r.sizedRuns, 2, "only the runs that reported a size");
  assert.equal(r.filesChanged, 4);
  assert.equal(r.linesChanged, 128);
  assert.equal(r.fixesProposed, 10);
  assert.equal(r.fixesApplied, 6);
  assert.equal(r.fixAdoptionRate, 0.6);
});

test("aggregateSkillByUser: rates are 0 when nothing was measured, never NaN", () => {
  const r = aggregateSkillByUser([sk({ id: "1" })])[0]!;
  for (const [k, v] of Object.entries(r)) {
    if (typeof v === "number") assert.ok(Number.isFinite(v), `${k} must be finite, got ${v}`);
  }
  assert.equal(r.fixAdoptionRate, 0);
  assert.equal(r.waitRatio, 0);
  assert.equal(r.p50ActiveMs, 0);
});

// --- Time range: the label and the window must agree ------------------------

test("sinceForRange: the window matches what the label promises", () => {
  const now = Date.parse("2026-08-09T00:00:00.000Z");
  const days = (r: Range) => Math.round((now - Date.parse(sinceForRange(r, now))) / 86_400_000);
  assert.equal(days("7d"), 7);
  assert.equal(days("30d"), 30);
  assert.equal(days("90d"), 90);
  assert.equal(days("365d"), 365);
});

test("bucketForRange: granularity follows the range, so the table stays readable", () => {
  assert.equal(bucketForRange("7d"), "day");
  assert.equal(bucketForRange("30d"), "week");
  assert.equal(bucketForRange("90d"), "week");
  assert.equal(bucketForRange("365d"), "month");
});

test("isRange: only the four offered ranges are accepted", () => {
  for (const ok of ["7d", "30d", "90d", "365d"]) assert.ok(isRange(ok));
  for (const bad of ["day", "week", "month", "1d", "", null]) assert.ok(!isRange(bad));
});
