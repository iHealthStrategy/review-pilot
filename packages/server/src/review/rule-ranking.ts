import { RULE_LOAD_POLICY, type ReviewRule } from "../domain/entities.js";

/**
 * Rule selection for a review: pick which rules are worth spending prompt
 * budget on, instead of sending the whole (unboundedly growing) ruleset.
 *
 * A project's ruleset grows every time a review auto-grows a key point into it.
 * Left alone it reaches hundreds of rules, and each review then has to weigh
 * every one of them against every changed file — slow, and no more accurate,
 * because most of the tail never fires.
 *
 * The ranking answers "which rules have earned their place":
 *   - rules that keep CATCHING things (high `hits`) rank first, and
 *   - genuinely NEW rules get a reserved share of the budget, because a rule
 *     that is never loaded can never record a hit and climb on its own.
 *
 * Everything else fills whatever budget is left, newest first — so a rule that
 * has gone cold sinks rather than disappearing, and comes back if it starts
 * hitting again.
 */

/** Result of a selection: the chosen rules plus what was left out. */
export interface RankedRules {
  /** The rules to send, already ordered "most worth reading" first. */
  rules: ReviewRule[];
  /** How many rules were eligible before the cap. */
  total: number;
  /** How many were dropped by the cap (`total - rules.length`). */
  omitted: number;
}

export interface RankRulesOptions {
  /** Budget for this review; defaults to {@link RULE_LOAD_POLICY.defaultLimit}. */
  limit?: number;
  /** Evaluation time, injectable for tests. */
  now?: number;
}

/** A rule is in effect unless it is a legacy pending candidate or disabled. */
export function isRuleInEffect(rule: ReviewRule): boolean {
  return !rule.pending && !rule.disabled;
}

const hitsOf = (r: ReviewRule): number =>
  typeof r.hits === "number" && Number.isFinite(r.hits) && r.hits > 0 ? r.hits : 0;

/** Epoch ms of `createdAt`, or 0 when absent/unparseable (ranks as oldest). */
const createdMs = (r: ReviewRule): number => {
  if (!r.createdAt) return 0;
  const t = Date.parse(r.createdAt);
  return Number.isFinite(t) ? t : 0;
};

const lastHitMs = (r: ReviewRule): number => {
  if (!r.lastHitAt) return 0;
  const t = Date.parse(r.lastHitAt);
  return Number.isFinite(t) ? t : 0;
};

/** Never caught anything yet — the rule still has everything to prove. */
const isUntried = (rule: ReviewRule): boolean => hitsOf(rule) === 0;

/**
 * Untried AND recently created, so it is the most topical thing to try next.
 * A rule with no `createdAt` predates hit-tracking, so it is untried but not
 * new — it goes in the dormant rotation instead.
 */
function isFresh(rule: ReviewRule, now: number): boolean {
  if (!isUntried(rule)) return false;
  const created = createdMs(rule);
  if (!created) return false;
  return now - created <= RULE_LOAD_POLICY.newRuleGraceMs;
}

/**
 * Rotate a list by a time-derived offset, so a fixed number of slots covers the
 * whole list over successive periods. Deterministic (same list + same period →
 * same order), which keeps ranking a pure function and avoids writing "last
 * loaded" state from an unauthenticated read.
 *
 * `stride` is how far the window advances per period — set it to the load budget
 * so consecutive periods take (almost) disjoint windows. Advancing by 1 instead
 * would take ~100 days to work through a 137-rule backlog; striding by the
 * budget covers it in a handful.
 */
function rotate<T>(items: readonly T[], now: number, stride: number): T[] {
  if (items.length <= 1) return [...items];
  const period = Math.floor(now / RULE_LOAD_POLICY.rotationPeriodMs);
  const raw = period * Math.max(1, stride);
  const offset = ((raw % items.length) + items.length) % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

/** Proven rules: most hits first, then most recently hit, then newest. */
function byValue(a: ReviewRule, b: ReviewRule): number {
  return (
    hitsOf(b) - hitsOf(a) ||
    lastHitMs(b) - lastHitMs(a) ||
    createdMs(b) - createdMs(a) ||
    a.title.localeCompare(b.title) // deterministic final tiebreak
  );
}

/** Untried rules: newest first. */
function byRecency(a: ReviewRule, b: ReviewRule): number {
  return createdMs(b) - createdMs(a) || a.title.localeCompare(b.title);
}

/**
 * Select and order the rules a review should load.
 *
 * Only rules in effect are considered. The budget is split: a reserved share
 * goes to untried-but-recent rules (newest first), the remainder to the
 * highest-value rules (most hits first). Unused slots on either side are
 * backfilled from the other pool, so a small ruleset always comes back whole.
 *
 * `limit <= 0` selects nothing but still reports the totals, which keeps
 * "how many rules does this project have" answerable without fetching them.
 */
export function rankRules(
  rules: readonly ReviewRule[],
  opts: RankRulesOptions = {},
): RankedRules {
  const now = opts.now ?? Date.now();
  const limit = Math.min(
    opts.limit ?? RULE_LOAD_POLICY.defaultLimit,
    RULE_LOAD_POLICY.maxLimit,
  );
  const eligible = rules.filter(isRuleInEffect);
  const total = eligible.length;
  if (limit <= 0) return { rules: [], total, omitted: total };

  // Three pools. `proven` earned their slots; `fresh` are new and topical;
  // `dormant` have never hit and are no longer new — including every rule from
  // before hit-tracking, which is why they get a rotating share rather than
  // being ranked into permanent invisibility.
  const proven = eligible.filter((r) => !isUntried(r)).sort(byValue);
  const fresh = eligible.filter((r) => isFresh(r, now)).sort(byRecency);
  const dormant = rotate(
    eligible
      .filter((r) => isUntried(r) && !isFresh(r, now))
      .sort((a, b) => a.title.localeCompare(b.title)),
    now,
    limit,
  );

  if (total <= limit) {
    // Everything fits: still order it, so the most useful rules are read first.
    return { rules: [...fresh, ...proven, ...dormant], total, omitted: 0 };
  }

  // Exploration block: a share of the budget for rules that have never hit,
  // split so the dormant rotation always gets a turn even when new rules are
  // plentiful. Proven rules keep at least one slot whenever any exist, so a
  // tiny budget is never spent entirely on exploration.
  const maxExplore = proven.length ? Math.max(0, limit - 1) : limit;
  const exploreBudget = Math.min(
    fresh.length + dormant.length,
    maxExplore,
    Math.max(1, Math.ceil(limit * RULE_LOAD_POLICY.newRuleShare)),
  );
  const dormantTarget = dormant.length
    ? Math.max(1, Math.floor(exploreBudget * RULE_LOAD_POLICY.dormantShareOfExploration))
    : 0;
  let takenDormant = dormant.slice(0, Math.min(dormantTarget, exploreBudget));
  const takenFresh = fresh.slice(0, exploreBudget - takenDormant.length);
  // Top the block back up when one pool was too small to use its share.
  if (takenFresh.length + takenDormant.length < exploreBudget) {
    takenDormant = dormant.slice(0, exploreBudget - takenFresh.length);
  }
  // Count per pool, then hand any budget a short pool left over to the others,
  // most-valuable pool first. Counting before assembling keeps the emitted ORDER
  // fixed (new → proven → rotating tail) no matter which pool ran dry — appending
  // leftovers to the end would have put a new rule behind the exploration tail.
  let nFresh = takenFresh.length;
  let nDormant = takenDormant.length;
  let nProven = Math.min(proven.length, limit - nFresh - nDormant);
  let spare = limit - (nFresh + nProven + nDormant);
  for (const pool of [
    { size: proven.length, take: (n: number) => (nProven += n), used: () => nProven },
    { size: fresh.length, take: (n: number) => (nFresh += n), used: () => nFresh },
    { size: dormant.length, take: (n: number) => (nDormant += n), used: () => nDormant },
  ]) {
    if (spare <= 0) break;
    const grow = Math.min(spare, pool.size - pool.used());
    if (grow > 0) {
      pool.take(grow);
      spare -= grow;
    }
  }

  const selected = [
    ...fresh.slice(0, nFresh),
    ...proven.slice(0, nProven),
    ...dormant.slice(0, nDormant),
  ];
  return { rules: selected, total, omitted: total - selected.length };
}

/**
 * Apply a review's hit report to a rule list: bump `hits` and stamp
 * `lastHitAt` for every rule whose title was reported.
 *
 * Titles are matched case-insensitively after trimming, because the reporter is
 * a model echoing back the title it was given. Unknown titles are ignored (a
 * rule may have been renamed or deleted since the review started), and each
 * title counts at most once per report so a repeated title can't inflate a
 * rule's standing. Returns the new list plus which titles actually matched.
 */
export function applyRuleHits(
  rules: readonly ReviewRule[],
  titles: readonly string[],
  at: string,
): { rules: ReviewRule[]; matched: string[] } {
  const wanted = new Set(
    titles.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0),
  );
  if (!wanted.size) return { rules: [...rules], matched: [] };
  const matched: string[] = [];
  const next = rules.map((rule) => {
    const key = rule.title.trim().toLowerCase();
    if (!wanted.has(key)) return rule;
    matched.push(rule.title);
    return { ...rule, hits: hitsOf(rule) + 1, lastHitAt: at };
  });
  return { rules: next, matched };
}
