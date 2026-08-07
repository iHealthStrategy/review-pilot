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

/**
 * True when a rule has not had a fair chance yet: never hit, and created within
 * the grace window. Rules with no `createdAt` predate hit-tracking and are NOT
 * new — they have had plenty of chances, we just weren't counting.
 */
function isUntried(rule: ReviewRule, now: number): boolean {
  if (hitsOf(rule) > 0) return false;
  const created = createdMs(rule);
  if (!created) return false;
  return now - created <= RULE_LOAD_POLICY.newRuleGraceMs;
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
  if (total <= limit) {
    // Everything fits: still order it, so the most useful rules are read first
    // even when nothing is dropped.
    const untried = eligible.filter((r) => isUntried(r, now)).sort(byRecency);
    const rest = eligible.filter((r) => !isUntried(r, now)).sort(byValue);
    return { rules: [...untried, ...rest], total, omitted: 0 };
  }

  const untried = eligible.filter((r) => isUntried(r, now)).sort(byRecency);
  const proven = eligible.filter((r) => !isUntried(r, now)).sort(byValue);

  // Reserve a share for untried rules, but never more than there are, and
  // never so many that proven rules get no slots at all.
  const reserved = Math.min(
    untried.length,
    Math.max(1, Math.ceil(limit * RULE_LOAD_POLICY.newRuleShare)),
  );
  const takenNew = untried.slice(0, reserved);
  // Backfill: whatever the untried pool didn't use goes to proven rules, and
  // vice versa when there are few proven rules.
  const takenProven = proven.slice(0, limit - takenNew.length);
  const selected = [...takenNew, ...takenProven];
  if (selected.length < limit) {
    const chosen = new Set(selected);
    for (const r of [...untried, ...proven]) {
      if (selected.length >= limit) break;
      if (!chosen.has(r)) {
        chosen.add(r);
        selected.push(r);
      }
    }
  }
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
