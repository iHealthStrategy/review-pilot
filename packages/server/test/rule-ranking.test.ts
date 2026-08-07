import assert from "node:assert/strict";
import { test } from "node:test";
import { RULE_LOAD_POLICY, type ReviewRule } from "../src/domain/entities.js";
import { applyRuleHits, isRuleInEffect, rankRules } from "../src/review/rule-ranking.js";

const NOW = Date.parse("2026-08-07T00:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

function rule(p: Partial<ReviewRule> & { title: string }): ReviewRule {
  return { instruction: "do the thing", globs: [], languages: [], topics: [], ...p };
}
const titles = (rules: readonly ReviewRule[]) => rules.map((r) => r.title);

test("rankRules: a small ruleset comes back whole, just ordered", () => {
  const out = rankRules(
    [
      rule({ title: "cold", hits: 0, createdAt: daysAgo(400) }),
      rule({ title: "hot", hits: 9, createdAt: daysAgo(400) }),
      rule({ title: "warm", hits: 3, createdAt: daysAgo(400) }),
    ],
    { now: NOW },
  );
  assert.equal(out.total, 3);
  assert.equal(out.omitted, 0);
  assert.deepEqual(titles(out.rules), ["hot", "warm", "cold"], "most hits first");
});

test("rankRules: excludes disabled and legacy pending rules from the budget", () => {
  const out = rankRules(
    [
      rule({ title: "live", hits: 1 }),
      rule({ title: "off", disabled: true, hits: 99 }),
      rule({ title: "legacy", pending: true, hits: 99 }),
    ],
    { now: NOW },
  );
  assert.deepEqual(titles(out.rules), ["live"]);
  assert.equal(out.total, 1, "ineligible rules are not counted as omitted either");
  assert.equal(out.omitted, 0);
});

test("rankRules: caps at the limit, keeping the highest-hit rules", () => {
  const many = Array.from({ length: 50 }, (_, i) =>
    rule({ title: `r${i}`, hits: i, createdAt: daysAgo(400) }),
  );
  const out = rankRules(many, { limit: 5, now: NOW });
  assert.equal(out.total, 50);
  assert.equal(out.rules.length, 5);
  assert.equal(out.omitted, 45);
  assert.deepEqual(titles(out.rules), ["r49", "r48", "r47", "r46", "r45"]);
});

test("rankRules: reserves slots for new rules so they can ever be tried", () => {
  // 40 proven rules would fill the budget on hits alone; the new ones must still
  // get in, otherwise a rule that is never loaded can never record a hit.
  const proven = Array.from({ length: 40 }, (_, i) =>
    rule({ title: `proven${i}`, hits: 100 + i, createdAt: daysAgo(400) }),
  );
  const fresh = Array.from({ length: 8 }, (_, i) =>
    rule({ title: `fresh${i}`, createdAt: daysAgo(i) }),
  );
  const out = rankRules([...proven, ...fresh], { limit: 10, now: NOW });
  assert.equal(out.rules.length, 10);
  const chosen = titles(out.rules);
  const newCount = chosen.filter((t) => t.startsWith("fresh")).length;
  assert.equal(newCount, 3, "ceil(10 * 0.3) slots reserved for untried rules");
  // New rules lead (newest first), then the best proven ones.
  assert.deepEqual(chosen.slice(0, 3), ["fresh0", "fresh1", "fresh2"]);
  assert.equal(chosen[3], "proven39", "highest hits leads the proven block");
});

test("rankRules: unused new-rule slots go back to proven rules", () => {
  const proven = Array.from({ length: 20 }, (_, i) =>
    rule({ title: `proven${i}`, hits: i + 1, createdAt: daysAgo(400) }),
  );
  const out = rankRules([...proven, rule({ title: "fresh", createdAt: daysAgo(1) })], {
    limit: 10,
    now: NOW,
  });
  assert.equal(out.rules.length, 10);
  assert.equal(titles(out.rules).filter((t) => t === "fresh").length, 1);
  assert.equal(
    titles(out.rules).filter((t) => t.startsWith("proven")).length,
    9,
    "only one untried rule exists, so the other reserved slots are backfilled",
  );
});

test("rankRules: a rule stops being 'new' once the grace window passes", () => {
  const old = daysAgo(RULE_LOAD_POLICY.newRuleGraceMs / 86_400_000 + 1);
  const proven = Array.from({ length: 10 }, (_, i) =>
    rule({ title: `proven${i}`, hits: 5, createdAt: daysAgo(400) }),
  );
  const out = rankRules([...proven, rule({ title: "stale", createdAt: old })], {
    limit: 3,
    now: NOW,
  });
  assert.ok(!titles(out.rules).includes("stale"), "expired grace → no reserved slot");
});

test("rankRules: a rule that already hit is never treated as untried", () => {
  const out = rankRules(
    [
      rule({ title: "new-and-hit", hits: 1, createdAt: daysAgo(1) }),
      rule({ title: "new-untried", createdAt: daysAgo(1) }),
    ],
    { limit: 1, now: NOW },
  );
  // The untried rule takes the single reserved slot; the hit one is "proven".
  assert.deepEqual(titles(out.rules), ["new-untried"]);
});

test("rankRules: rules predating hit-tracking rank as oldest, not as new", () => {
  // No createdAt = created before this feature; it has had its chances, we just
  // weren't counting. It must not out-rank a rule that demonstrably hits.
  const out = rankRules(
    [rule({ title: "legacy-no-dates" }), rule({ title: "hits", hits: 2, createdAt: daysAgo(400) })],
    { limit: 1, now: NOW },
  );
  assert.deepEqual(titles(out.rules), ["hits"]);
});

test("rankRules: equal hits break ties by most recent hit, then deterministically", () => {
  const out = rankRules(
    [
      rule({ title: "b", hits: 2, lastHitAt: daysAgo(9) }),
      rule({ title: "a", hits: 2, lastHitAt: daysAgo(1) }),
      rule({ title: "c", hits: 2, lastHitAt: daysAgo(9) }),
    ],
    { now: NOW },
  );
  assert.deepEqual(titles(out.rules), ["a", "b", "c"], "recent hit wins; then title order");
});

test("rankRules: limit 0 selects nothing but still reports the total", () => {
  const out = rankRules([rule({ title: "x" }), rule({ title: "y" })], { limit: 0, now: NOW });
  assert.deepEqual(out.rules, []);
  assert.equal(out.total, 2);
  assert.equal(out.omitted, 2);
});

test("rankRules: never exceeds the hard ceiling, whatever the caller asks", () => {
  const many = Array.from({ length: RULE_LOAD_POLICY.maxLimit + 50 }, (_, i) =>
    rule({ title: `r${i}`, hits: 1 }),
  );
  const out = rankRules(many, { limit: 10_000, now: NOW });
  assert.equal(out.rules.length, RULE_LOAD_POLICY.maxLimit);
});

test("isRuleInEffect: only non-pending, non-disabled rules apply", () => {
  assert.equal(isRuleInEffect(rule({ title: "a" })), true);
  assert.equal(isRuleInEffect(rule({ title: "a", disabled: true })), false);
  assert.equal(isRuleInEffect(rule({ title: "a", pending: true })), false);
});

// --- hit reporting ---

test("applyRuleHits: increments matched rules and stamps the time", () => {
  const at = "2026-08-07T12:00:00.000Z";
  const { rules, matched } = applyRuleHits(
    [rule({ title: "SQL safety", hits: 2 }), rule({ title: "No console.log" })],
    ["SQL safety"],
    at,
  );
  assert.deepEqual(matched, ["SQL safety"]);
  assert.equal(rules[0]!.hits, 3);
  assert.equal(rules[0]!.lastHitAt, at);
  assert.equal(rules[1]!.hits, undefined, "untouched rule keeps its shape");
});

test("applyRuleHits: matches case-insensitively after trimming", () => {
  const { matched, rules } = applyRuleHits(
    [rule({ title: "SQL safety" })],
    ["  sql SAFETY "],
    "2026-08-07T12:00:00.000Z",
  );
  assert.deepEqual(matched, ["SQL safety"]);
  assert.equal(rules[0]!.hits, 1);
});

test("applyRuleHits: a repeated title counts once per report", () => {
  const { rules } = applyRuleHits(
    [rule({ title: "SQL safety" })],
    ["SQL safety", "SQL safety", "sql safety"],
    "2026-08-07T12:00:00.000Z",
  );
  assert.equal(rules[0]!.hits, 1, "this is an earned-its-slot signal, not a finding count");
});

test("applyRuleHits: unknown and empty titles are ignored", () => {
  const before = [rule({ title: "SQL safety", hits: 1 })];
  const { rules, matched } = applyRuleHits(before, ["renamed away", "", "   "], "2026-08-07T12:00:00.000Z");
  assert.deepEqual(matched, []);
  assert.deepEqual(rules, before);
});
