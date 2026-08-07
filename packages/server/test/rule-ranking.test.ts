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
  // r0 has no hits, so it belongs to the exploration tail and takes one slot;
  // the remaining budget goes to the highest-hit rules, in order, up front.
  assert.deepEqual(titles(out.rules).slice(0, 4), ["r49", "r48", "r47", "r46"]);
  assert.deepEqual(titles(out.rules).slice(4), ["r0"], "one rotating exploration slot, read last");
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

// --- pre-existing data: rules that predate hit-tracking ---------------------
// These have neither createdAt nor hits. Ranking them purely by value would sort
// them by title and freeze the same arbitrary top-N forever: never loaded → can
// never record a hit → can never climb. The dormant rotation is what prevents
// that, and it matters most for exactly the big old rulesets this policy exists
// to speed up.

const legacyRules = (n: number) =>
  Array.from({ length: n }, (_, i) => rule({ title: `legacy-${String(i).padStart(3, "0")}` }));

test("rankRules: legacy rules rotate, so none is starved forever", () => {
  const rules = legacyRules(137);
  const day = 24 * 60 * 60 * 1000;
  const seen = new Set<string>();
  let periods = 0;
  for (let d = 0; d < 500; d += 1) {
    const out = rankRules(rules, { limit: 40, now: NOW + d * day });
    assert.equal(out.rules.length, 40, "still capped every period");
    titles(out.rules).forEach((t) => seen.add(t));
    if (seen.size === rules.length) {
      periods = d + 1;
      break;
    }
  }
  assert.equal(seen.size, 137, "every rule eventually gets loaded");
  assert.ok(periods > 0 && periods <= 10, `full coverage should take a few periods, took ${periods}`);
});

test("rankRules: the legacy selection actually changes between periods", () => {
  const rules = legacyRules(137);
  const day = 24 * 60 * 60 * 1000;
  const a = new Set(titles(rankRules(rules, { limit: 40, now: NOW }).rules));
  const b = new Set(titles(rankRules(rules, { limit: 40, now: NOW + day }).rules));
  const overlap = [...a].filter((t) => b.has(t)).length;
  assert.ok(overlap < 40, `consecutive periods must not select the same 40 (overlap ${overlap})`);
});

test("rankRules: rotation is deterministic within a period", () => {
  const rules = legacyRules(50);
  const first = titles(rankRules(rules, { limit: 10, now: NOW }).rules);
  const again = titles(rankRules(rules, { limit: 10, now: NOW + 60_000 }).rules);
  assert.deepEqual(first, again, "same period → same selection, so ranking stays a pure function");
});

test("rankRules: rotation never starves proven or new rules to make room", () => {
  const rules = [
    ...legacyRules(137),
    ...Array.from({ length: 6 }, (_, i) => rule({ title: `hot-${i}`, hits: 30 - i, createdAt: daysAgo(200) })),
    ...Array.from({ length: 5 }, (_, i) => rule({ title: `new-${i}`, createdAt: daysAgo(i / 24) })),
  ];
  const chosen = titles(rankRules(rules, { limit: 40, now: NOW }).rules);
  assert.equal(chosen.filter((t) => t.startsWith("hot-")).length, 6, "all proven rules load");
  assert.equal(chosen.filter((t) => t.startsWith("new-")).length, 5, "all new rules load");
  assert.ok(chosen.filter((t) => t.startsWith("legacy-")).length > 0, "dormant rules still get turns");
  assert.deepEqual(chosen.slice(0, 5), ["new-0", "new-1", "new-2", "new-3", "new-4"], "new leads");
});

test("rankRules: a rule stops LEADING once its grace window passes", () => {
  const old = daysAgo(RULE_LOAD_POLICY.newRuleGraceMs / 86_400_000 + 1);
  const proven = Array.from({ length: 10 }, (_, i) =>
    rule({ title: `proven${i}`, hits: 5, createdAt: daysAgo(400) }),
  );
  const out = rankRules([...proven, rule({ title: "stale", createdAt: old })], {
    limit: 3,
    now: NOW,
  });
  // It drops out of the "new and topical" block and into the exploration tail:
  // still reachable (so it can earn hits) but read after the proven rules.
  assert.ok(titles(out.rules).includes("stale"));
  assert.notEqual(titles(out.rules)[0], "stale", "expired grace → no longer leads");
  assert.equal(titles(out.rules).at(-1), "stale");
});

test("rankRules: proven rules keep a slot even when the budget is 1", () => {
  const out = rankRules(
    [rule({ title: "dormant" }), rule({ title: "hits", hits: 2, createdAt: daysAgo(400) })],
    { limit: 1, now: NOW },
  );
  assert.deepEqual(titles(out.rules), ["hits"], "a tiny budget is not spent on exploration");
});

test("rankRules: a rule that already hit is proven, not competing for exploration", () => {
  // Even a day-old rule counts as proven once it has caught something, so it is
  // kept via the proven block rather than fighting fresher rules for the
  // (limited) exploration slots.
  const fresh = Array.from({ length: 20 }, (_, i) =>
    rule({ title: `fresh${String(i).padStart(2, "0")}`, createdAt: daysAgo(i / 24) }),
  );
  const out = rankRules([...fresh, rule({ title: "new-and-hit", hits: 1, createdAt: daysAgo(0.5) })], {
    limit: 5,
    now: NOW,
  });
  assert.ok(
    titles(out.rules).includes("new-and-hit"),
    "survives via the proven block even though the exploration block is oversubscribed",
  );
});

test("rankRules: rules predating hit-tracking never LEAD, but stay reachable", () => {
  // No createdAt = created before this feature. It must not out-rank a rule that
  // demonstrably hits, but it must still be loadable — otherwise it could never
  // record a hit and would be invisible forever.
  const out = rankRules(
    [rule({ title: "legacy-no-dates" }), rule({ title: "hits", hits: 2, createdAt: daysAgo(400) })],
    { limit: 2, now: NOW },
  );
  assert.deepEqual(titles(out.rules), ["hits", "legacy-no-dates"]);
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

test("rankRules: read order stays new → proven → trial even when a pool runs dry", () => {
  // Only one proven rule, so most of the budget is backfilled from the fresh and
  // dormant pools. The backfilled rules must still land in their proper block —
  // a new rule must never be emitted behind the exploration tail.
  const rules = [
    rule({ title: "hot", hits: 9, createdAt: daysAgo(400) }),
    ...Array.from({ length: 6 }, (_, i) => rule({ title: `new${i}`, createdAt: daysAgo(i / 24) })),
    ...Array.from({ length: 6 }, (_, i) => rule({ title: `cold${i}` })),
  ];
  const out = rankRules(rules, { limit: 8, now: NOW });
  assert.equal(out.rules.length, 8);
  const kind = (t: string) => (t.startsWith("new") ? 0 : t === "hot" ? 1 : 2);
  const order = titles(out.rules).map(kind);
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
    `blocks must not interleave, got ${titles(out.rules).join(",")}`,
  );
  assert.ok(titles(out.rules).includes("hot"), "the proven rule is never dropped");
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
