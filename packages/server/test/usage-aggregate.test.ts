import assert from "node:assert/strict";
import { test } from "node:test";
import type { SkillFinding, SkillUsage, TokenUsage } from "../src/domain/entities.js";
import {
  aggregateSkillByProject,
  aggregateSkillByUser,
  aggregateUsage,
  bucketKey,
  defaultSince,
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
