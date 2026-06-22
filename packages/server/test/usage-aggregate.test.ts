import assert from "node:assert/strict";
import { test } from "node:test";
import type { TokenUsage } from "../src/domain/entities.js";
import { aggregateUsage, bucketKey, defaultSince } from "../src/usage/aggregate.js";

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
