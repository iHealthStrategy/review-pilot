import type { Severity, SkillUsage, TokenUsage, UsageSource } from "../domain/entities.js";

/** Time granularity for token-usage aggregation. */
export type Bucket = "day" | "week" | "month";

/**
 * Bucket key for an ISO timestamp:
 *  - day:   `YYYY-MM-DD`
 *  - month: `YYYY-MM`
 *  - week:  the (UTC) Monday of that week as `YYYY-MM-DD`
 * Day/month are pure string slices; week needs date math.
 */
export function bucketKey(iso: string, bucket: Bucket): string {
  if (bucket === "month") return iso.slice(0, 7);
  if (bucket === "day") return iso.slice(0, 10);
  const d = new Date(iso);
  const dow = d.getUTCDay(); // 0=Sun .. 6=Sat
  const shift = dow === 0 ? -6 : 1 - dow; // back to Monday
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() + shift);
  return monday.toISOString().slice(0, 10);
}

/** One aggregated cell: a (source, task, time-bucket) total. */
export interface UsageRow {
  source: UsageSource;
  sourceId: string;
  sourceLabel: string;
  bucket: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  runs: number;
  /** True if ANY contributing record was an estimate (not engine-reported). */
  estimated: boolean;
}

/**
 * Sum usage records into (source, sourceId, bucket) rows. Sorted newest bucket
 * first, then by total tokens descending.
 */
export function aggregateUsage(events: readonly TokenUsage[], bucket: Bucket): UsageRow[] {
  const rows = new Map<string, UsageRow>();
  for (const e of events) {
    const b = bucketKey(e.at, bucket);
    const key = `${e.source}\0${e.sourceId}\0${b}`;
    let row = rows.get(key);
    if (!row) {
      row = {
        source: e.source,
        sourceId: e.sourceId,
        sourceLabel: e.sourceLabel,
        bucket: b,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        runs: 0,
        estimated: false,
      };
      rows.set(key, row);
    }
    row.inputTokens += e.inputTokens;
    row.outputTokens += e.outputTokens;
    row.totalTokens += e.totalTokens;
    row.runs += 1;
    if (e.estimated) row.estimated = true;
    row.sourceLabel = e.sourceLabel; // keep the most recent label
  }
  return [...rows.values()].sort((a, b2) =>
    a.bucket < b2.bucket ? 1 : a.bucket > b2.bucket ? -1 : b2.totalTokens - a.totalTokens,
  );
}

/** One aggregated skill-usage row: a user's totals over the queried window. */
export interface SkillUserUsageRow {
  userId: string;
  userLabel: string;
  /** Number of review runs reported. */
  runs: number;
  /** Total reported findings (sum of the severity counts). */
  findings: number;
  critical: number;
  major: number;
  minor: number;
  info: number;
  /**
   * Timing, over the runs that actually reported it — `timedRuns` is that
   * subset, so the UI can say "averaged over N of M runs" instead of
   * silently diluting the average with pre-feature runs that reported none.
   */
  timedRuns: number;
  totalDurationMs: number;
  totalActiveMs: number;
  /** Mean over `timedRuns`; 0 when nothing was timed. */
  avgDurationMs: number;
  avgActiveMs: number;
  /**
   * First-pass rate: of the CHANGES this user reviewed, the share whose FIRST
   * review came back with no major/critical finding — i.e. it would have passed
   * the merge gate without a fix-and-re-review cycle.
   *
   * Counted per change, not per run, because a change that fails necessarily
   * produces extra runs; a per-run ratio would punish the same failure twice
   * and would improve simply by re-reviewing until clean. Runs carrying no
   * `changeKey` cannot be grouped, so each counts as its own change.
   */
  changesReviewed: number;
  cleanFirstPass: number;
  /** cleanFirstPass / changesReviewed, 0..1; 0 when nothing was reviewed. */
  firstPassRate: number;
  /** Distinct projects touched — breadth, not just volume. */
  projects: number;
  /** Distinct UTC days with at least one review — habit, not just totals. */
  activeDays: number;
  /** Runs per scope: reviewing while writing vs only at PR time. */
  scopeWorking: number;
  scopeBranch: number;
  scopeWhole: number;
  /** Median and 90th-percentile durations — an average hides the long tail. */
  p50ActiveMs: number;
  p90ActiveMs: number;
  p50DurationMs: number;
  p90DurationMs: number;
  /** Share of wall-clock spent waiting on the user, 0..1 (timed runs only). */
  waitRatio: number;
  /** Findings per run, normalised for volume. */
  findingsPerRun: number;
  /** Reviewed change size, over the runs that reported it. */
  sizedRuns: number;
  filesChanged: number;
  linesChanged: number;
  /** One-shot fix pass: offered vs accepted, and the resulting adoption rate. */
  fixesProposed: number;
  fixesApplied: number;
  /** fixesApplied / fixesProposed, 0..1; 0 when nothing was ever proposed. */
  fixAdoptionRate: number;
  /** ISO timestamp of the most recent run. */
  lastAt: string;
}

/** Nearest-rank percentile over an unsorted numeric sample; 0 when empty. */
export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank: the smallest value at or above the p-th position. Stable for
  // tiny samples, where interpolation invents numbers nobody measured.
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1]!;
}

/** A run has a must-fix problem when it reported anything at major or above. */
const isClean = (e: SkillUsage): boolean => e.critical === 0 && e.major === 0;

/**
 * Sum skill-usage events per user. Sorted by run count desc, then most-recent
 * first. The label tracks the most recent record so a renamed handle/email
 * shows its latest form.
 */
export function aggregateSkillByUser(events: readonly SkillUsage[]): SkillUserUsageRow[] {
  const rows = new Map<string, SkillUserUsageRow>();
  // Per-user side tables the row shape doesn't hold: percentile samples and the
  // distinct-value sets, plus the earliest run per change (for first-pass rate).
  interface Side {
    durations: number[];
    actives: number[];
    projects: Set<string>;
    days: Set<string>;
    /** changeKey → the earliest run seen for that change. */
    firstOfChange: Map<string, SkillUsage>;
  }
  const side = new Map<string, Side>();

  for (const e of events) {
    let row = rows.get(e.userId);
    if (!row) {
      row = {
        userId: e.userId,
        userLabel: e.userLabel,
        runs: 0,
        findings: 0,
        critical: 0,
        major: 0,
        minor: 0,
        info: 0,
        timedRuns: 0,
        totalDurationMs: 0,
        totalActiveMs: 0,
        avgDurationMs: 0,
        avgActiveMs: 0,
        changesReviewed: 0,
        cleanFirstPass: 0,
        firstPassRate: 0,
        projects: 0,
        activeDays: 0,
        scopeWorking: 0,
        scopeBranch: 0,
        scopeWhole: 0,
        p50ActiveMs: 0,
        p90ActiveMs: 0,
        p50DurationMs: 0,
        p90DurationMs: 0,
        waitRatio: 0,
        findingsPerRun: 0,
        sizedRuns: 0,
        filesChanged: 0,
        linesChanged: 0,
        fixesProposed: 0,
        fixesApplied: 0,
        fixAdoptionRate: 0,
        lastAt: e.at,
      };
      rows.set(e.userId, row);
      side.set(e.userId, {
        durations: [],
        actives: [],
        projects: new Set(),
        days: new Set(),
        firstOfChange: new Map(),
      });
    }
    const s = side.get(e.userId)!;
    row.runs += 1;
    row.critical += e.critical;
    row.major += e.major;
    row.minor += e.minor;
    row.info += e.info;
    row.findings += e.critical + e.major + e.minor + e.info;
    if (e.project) s.projects.add(e.project);
    s.days.add(e.at.slice(0, 10));
    if (e.scope === "working") row.scopeWorking += 1;
    else if (e.scope === "branch") row.scopeBranch += 1;
    else row.scopeWhole += 1;

    // Only count a run as timed when it reported a wall-clock duration. A run
    // may report duration without activeMs (no user prompts to subtract), in
    // which case active falls back to the full duration.
    if (typeof e.durationMs === "number") {
      const active = typeof e.activeMs === "number" ? e.activeMs : e.durationMs;
      row.timedRuns += 1;
      row.totalDurationMs += e.durationMs;
      row.totalActiveMs += active;
      s.durations.push(e.durationMs);
      s.actives.push(active);
    }
    if (typeof e.filesChanged === "number" || typeof e.linesChanged === "number") {
      row.sizedRuns += 1;
      row.filesChanged += e.filesChanged ?? 0;
      row.linesChanged += e.linesChanged ?? 0;
    }
    if (typeof e.fixesProposed === "number") row.fixesProposed += e.fixesProposed;
    if (typeof e.fixesApplied === "number") row.fixesApplied += e.fixesApplied;

    // First-pass rate is per CHANGE. Runs with no changeKey can't be grouped, so
    // each stands alone under a key unique to that run.
    const key = e.changeKey || ` run:${e.id}`;
    const prev = s.firstOfChange.get(key);
    if (!prev || e.at < prev.at) s.firstOfChange.set(key, e);

    if (e.at > row.lastAt) {
      row.lastAt = e.at;
      row.userLabel = e.userLabel; // keep the most recent label
    }
  }

  for (const [userId, row] of rows) {
    const s = side.get(userId)!;
    if (row.timedRuns) {
      row.avgDurationMs = Math.round(row.totalDurationMs / row.timedRuns);
      row.avgActiveMs = Math.round(row.totalActiveMs / row.timedRuns);
      row.p50DurationMs = percentile(s.durations, 50);
      row.p90DurationMs = percentile(s.durations, 90);
      row.p50ActiveMs = percentile(s.actives, 50);
      row.p90ActiveMs = percentile(s.actives, 90);
      row.waitRatio = row.totalDurationMs
        ? (row.totalDurationMs - row.totalActiveMs) / row.totalDurationMs
        : 0;
    }
    row.projects = s.projects.size;
    row.activeDays = s.days.size;
    row.findingsPerRun = row.runs ? row.findings / row.runs : 0;
    row.changesReviewed = s.firstOfChange.size;
    row.cleanFirstPass = [...s.firstOfChange.values()].filter(isClean).length;
    row.firstPassRate = row.changesReviewed ? row.cleanFirstPass / row.changesReviewed : 0;
    row.fixAdoptionRate = row.fixesProposed ? row.fixesApplied / row.fixesProposed : 0;
  }
  return [...rows.values()].sort((a, b) =>
    b.runs - a.runs || (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0),
  );
}

/** One aggregated project row: what this project's reviews keep turning up. */
export interface SkillProjectUsageRow {
  /** Normalized project key; "" when the skill couldn't resolve a git remote. */
  project: string;
  runs: number;
  findings: number;
  critical: number;
  major: number;
  minor: number;
  info: number;
  /** Distinct reporting users, so a project's stats read in context. */
  reviewers: number;
  /**
   * The recurring problems, most frequent first — findings grouped by
   * severity + title, since the same rule violation reported across runs is
   * the signal worth acting on. Capped by `topProblems`.
   */
  problems: SkillProblemRow[];
  lastAt: string;
}

/** One recurring problem within a project. */
export interface SkillProblemRow {
  severity: Severity;
  title: string;
  /** How many times this problem was reported. */
  count: number;
  /** Distinct files it was reported in, most recent first, capped. */
  files: string[];
  /** One representative explanation, for context in the UI. */
  detail?: string;
}

/**
 * Group skill-usage events per project and roll their findings up into
 * recurring problems, for the "what does this project keep getting wrong"
 * view. Problems are keyed by severity + normalized title so the same issue
 * reported in different files collapses into one row with a file list.
 *
 * Runs that reported counts only (older skills) still contribute their run
 * count and severity totals — they just have no `problems` to add.
 */
export function aggregateSkillByProject(
  events: readonly SkillUsage[],
  opts: { topProblems?: number; maxFiles?: number } = {},
): SkillProjectUsageRow[] {
  const topProblems = opts.topProblems ?? 20;
  const maxFiles = opts.maxFiles ?? 10;
  interface Acc {
    row: SkillProjectUsageRow;
    users: Set<string>;
    problems: Map<string, { p: SkillProblemRow; files: Set<string> }>;
  }
  const accs = new Map<string, Acc>();
  for (const e of events) {
    let acc = accs.get(e.project);
    if (!acc) {
      acc = {
        row: {
          project: e.project,
          runs: 0,
          findings: 0,
          critical: 0,
          major: 0,
          minor: 0,
          info: 0,
          reviewers: 0,
          problems: [],
          lastAt: e.at,
        },
        users: new Set(),
        problems: new Map(),
      };
      accs.set(e.project, acc);
    }
    const { row } = acc;
    row.runs += 1;
    row.critical += e.critical;
    row.major += e.major;
    row.minor += e.minor;
    row.info += e.info;
    row.findings += e.critical + e.major + e.minor + e.info;
    acc.users.add(e.userId);
    if (e.at > row.lastAt) row.lastAt = e.at;
    for (const f of e.findings ?? []) {
      const key = `${f.severity} ${f.title.trim().toLowerCase()}`;
      let entry = acc.problems.get(key);
      if (!entry) {
        entry = {
          p: {
            severity: f.severity,
            title: f.title,
            count: 0,
            files: [],
            ...(f.detail ? { detail: f.detail } : {}),
          },
          files: new Set(),
        };
        acc.problems.set(key, entry);
      }
      entry.p.count += 1;
      if (f.filePath) entry.files.add(f.filePath);
    }
  }
  const rank: Record<Severity, number> = { critical: 0, major: 1, minor: 2, info: 3 };
  const out: SkillProjectUsageRow[] = [];
  for (const acc of accs.values()) {
    acc.row.reviewers = acc.users.size;
    acc.row.problems = [...acc.problems.values()]
      .map(({ p, files }) => ({ ...p, files: [...files].slice(0, maxFiles) }))
      // Most frequent first; ties broken by severity so critical floats up.
      .sort((a, b) => b.count - a.count || rank[a.severity] - rank[b.severity])
      .slice(0, topProblems);
    out.push(acc.row);
  }
  return out.sort((a, b) =>
    b.findings - a.findings || b.runs - a.runs || (a.lastAt < b.lastAt ? 1 : -1),
  );
}

/**
 * How far back a range reaches. These ARE the ranges the UI offers, so the
 * label and the window agree: "近 7 天" scans seven days, not thirty.
 *
 * The old mapping (day→30d, week→84d, month→366d) treated the control as a
 * token-aggregation *granularity* and reused it as a *window*, which meant the
 * "日" button actually scanned a month — and every skill-usage view returned an
 * identical result for all three settings, because the data all fell inside
 * even the narrowest window.
 */
export const RANGE_DAYS = { "7d": 7, "30d": 30, "90d": 90, "365d": 365 } as const;
export type Range = keyof typeof RANGE_DAYS;

export function isRange(v: string | null): v is Range {
  return v !== null && v in RANGE_DAYS;
}

/**
 * Token usage is grouped into buckets for display; pick a granularity that
 * keeps the table readable at each range instead of asking the user to choose
 * a window and a granularity separately.
 */
export function bucketForRange(range: Range): Bucket {
  return range === "7d" ? "day" : range === "365d" ? "month" : "week";
}

/** Lower bound for a range. */
export function sinceForRange(range: Range, now: number = Date.now()): string {
  return new Date(now - RANGE_DAYS[range] * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Legacy lower bound for a bucket. Kept so an older client still gets a sane
 * window from `?bucket=`; new callers should send `?range=`.
 */
export function defaultSince(bucket: Bucket, now: number = Date.now()): string {
  const days = bucket === "month" ? 366 : bucket === "week" ? 84 : 30;
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
}
