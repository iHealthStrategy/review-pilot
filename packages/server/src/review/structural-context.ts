import * as path from "node:path";
import { existsSync } from "node:fs";
import { type CommandRunner, ProcessCommandRunner } from "./command-runner.js";

/**
 * Structural context derived from the `code-review-graph` knowledge graph: the
 * risk-scored, relationship-aware signal the flat file-listing in
 * {@link buildReviewPrompt} can't provide. Produced by invoking the SAME Python
 * function the graph's `detect_changes` MCP tool uses ({@link detect_changes_func}),
 * so no MCP server is needed — just the package on PATH via the launcher.
 */
export interface StructuralContext {
  /** Overall risk of the change set, 0..1 (max of per-node risk). */
  riskScore: number;
  /** One-line human summary the tool produces. */
  summary: string;
  /** Nodes to review first, highest risk first. */
  reviewPriorities: GraphNode[];
  /** Changed functions/classes with no test coverage. */
  testGaps: GraphNode[];
  /** Execution flows touched by the change, most critical first. */
  affectedFlows: AffectedFlow[];
}

export interface GraphNode {
  name: string;
  filePath: string; // repo-relative once rendered
  lineStart?: number;
  kind?: string;
  riskScore?: number;
}

export interface AffectedFlow {
  name: string;
  criticality?: number;
}

export interface StructuralContextOptions {
  /** Diff base for change detection (a ref or sha valid in the workspace). */
  base: string;
  /** Launcher that puts `code-review-graph` on PATH. Default "uvx". */
  launcher?: string;
  /** Hard timeout per subprocess (ms). */
  timeoutMs?: number;
  /**
   * Pin the graph DB location (sets `CRG_DATA_DIR`). Use a path UNIQUE to this
   * job (e.g. inside its workspace) so concurrent reviews never write the same
   * `graph.db` — and so an ambient global `CRG_DATA_DIR` can't make them collide.
   * Unset → the tool default (`<repo>/.code-review-graph`).
   */
  dataDir?: string;
}

export interface StructuralContextHooks {
  commandRunner?: CommandRunner;
  onLog?: (message: string) => void;
  /** Test seam: whether a graph DB already exists for `dir` (data dir respected). */
  graphExists?: (dir: string, dataDir?: string) => boolean;
}

/** Python that calls the graph's own detect_changes and prints its JSON. */
const DETECT_PY = [
  "import json, sys",
  "from code_review_graph.tools.review import detect_changes_func",
  "try:",
  "    r = detect_changes_func(base=sys.argv[2], repo_root=sys.argv[1],",
  "                            detail_level='standard', include_source=False)",
  "    print(json.dumps(r, default=str))",
  "except Exception as e:",
  "    print(json.dumps({'status': 'error', 'message': str(e)}))",
].join("\n");

/**
 * Build {@link StructuralContext} for the change set at `dir`. Ensures the graph
 * exists (full build first time, incremental update otherwise — both
 * best-effort), then runs detect_changes. Returns null on ANY failure (tool
 * missing, parse error, empty result) so the caller's review proceeds unaffected.
 */
export async function buildStructuralContext(
  dir: string,
  options: StructuralContextOptions,
  hooks: StructuralContextHooks = {},
): Promise<StructuralContext | null> {
  const runner = hooks.commandRunner ?? new ProcessCommandRunner();
  const log = hooks.onLog ?? (() => {});
  const launcher = options.launcher?.trim() || "uvx";
  const timeout = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : undefined;
  // CRG_DATA_DIR pins the graph location for THIS invocation, overriding any
  // ambient value. Scoping it per-job is what keeps concurrent reviews from
  // racing on a shared graph.db (see StructuralContextOptions.dataDir).
  const env = options.dataDir ? { CRG_DATA_DIR: options.dataDir } : undefined;
  const exists = (hooks.graphExists ?? defaultGraphExists)(dir, options.dataDir);

  // Keep the graph current for `dir` — non-fatal: a stale graph still yields
  // useful (if slightly off) risk signal, so we never abort the review here.
  log(exists ? "Updating code graph…" : "Building code graph (first run)…");
  const buildArgs = exists
    ? ["code-review-graph", "update", "--repo", dir, "--base", options.base]
    : ["code-review-graph", "build", "--repo", dir];
  const built = await runner.run(launcher, buildArgs, {
    cwd: dir,
    ...(timeout ? { timeoutMs: timeout } : {}),
    ...(env ? { env } : {}),
  });
  if (built.code !== 0) {
    log(`Code graph ${exists ? "update" : "build"} failed (skipping structural context): ${built.stderr.trim().slice(0, 200)}`);
    return null;
  }

  log("Analyzing structural impact…");
  const res = await runner.run(
    launcher,
    ["--from", "code-review-graph", "python", "-c", DETECT_PY, dir, options.base],
    { cwd: dir, ...(timeout ? { timeoutMs: timeout } : {}), ...(env ? { env } : {}) },
  );
  if (res.code !== 0) {
    log(`Structural analysis failed (skipping): ${res.stderr.trim().slice(0, 200)}`);
    return null;
  }

  const parsed = parseStructuralJson(res.stdout);
  if (!parsed) {
    log("Structural analysis produced no usable output (skipping).");
    return null;
  }
  return parsed;
}

function defaultGraphExists(dir: string, dataDir?: string): boolean {
  const graphDir = dataDir ?? path.join(dir, ".code-review-graph");
  return existsSync(path.join(graphDir, "graph.db"));
}

/** Parse the detect_changes / analyze_changes JSON, tolerant of leading log noise. */
export function parseStructuralJson(stdout: string): StructuralContext | null {
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.slice(start));
  } catch {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (obj.status === "error") return null;

  const node = (v: unknown): GraphNode => {
    const o = (v ?? {}) as Record<string, unknown>;
    return {
      name: String(o.name ?? o.qualified_name ?? "?"),
      filePath: String(o.file_path ?? o.file ?? ""),
      ...(typeof o.line_start === "number" ? { lineStart: o.line_start } : {}),
      ...(typeof o.kind === "string" ? { kind: o.kind } : {}),
      ...(typeof o.risk_score === "number" ? { riskScore: o.risk_score } : {}),
    };
  };
  const list = (v: unknown): Record<string, unknown>[] =>
    Array.isArray(v) ? (v as Record<string, unknown>[]) : [];

  const ctx: StructuralContext = {
    riskScore: typeof obj.risk_score === "number" ? obj.risk_score : 0,
    summary: typeof obj.summary === "string" ? obj.summary : "",
    reviewPriorities: list(obj.review_priorities).map(node),
    testGaps: list(obj.test_gaps).map(node),
    affectedFlows: list(obj.affected_flows).map((f) => ({
      name: String(f.name ?? "?"),
      ...(typeof f.criticality === "number" ? { criticality: f.criticality } : {}),
    })),
  };
  // Nothing actionable → treat as absent so we don't spend prompt tokens on it.
  if (
    ctx.reviewPriorities.length === 0 &&
    ctx.testGaps.length === 0 &&
    ctx.affectedFlows.length === 0
  ) {
    return null;
  }
  return ctx;
}

const MAX_PRIORITIES = 10;
const MAX_TEST_GAPS = 12;
const MAX_FLOWS = 5;

/**
 * Render {@link StructuralContext} as a compact, token-budgeted prompt section.
 * Absolute graph paths are made repo-relative so they line up with the diff.
 */
export function renderStructuralContext(ctx: StructuralContext, workspaceDir: string): string {
  const rel = (p: string) =>
    p && path.isAbsolute(p) ? path.relative(workspaceDir, p) : p;
  const loc = (n: GraphNode) =>
    `${rel(n.filePath)}${n.lineStart ? `:${n.lineStart}` : ""}`;

  const lines: string[] = [
    "## Structural context (from code-review-graph)",
    "Precomputed structural analysis of this change set — use it to focus the",
    "review on the highest-risk, relationship-heavy code and the test gaps below.",
    `Overall change risk: ${ctx.riskScore.toFixed(2)} / 1.00`,
  ];

  const priorities = ctx.reviewPriorities.slice(0, MAX_PRIORITIES);
  if (priorities.length) {
    lines.push("", "### Review first (highest risk)");
    for (const n of priorities) {
      const risk = n.riskScore != null ? `[risk ${n.riskScore.toFixed(2)}] ` : "";
      const kind = n.kind ? `${n.kind} ` : "";
      lines.push(`- ${risk}${kind}${n.name} — ${loc(n)}`);
    }
  }

  const gaps = ctx.testGaps.slice(0, MAX_TEST_GAPS);
  if (gaps.length) {
    lines.push("", "### Changed code with NO test coverage");
    for (const n of gaps) lines.push(`- ${n.name} — ${loc(n)}`);
  }

  const flows = ctx.affectedFlows.slice(0, MAX_FLOWS);
  if (flows.length) {
    lines.push("", "### Execution flows affected");
    for (const f of flows) {
      const c = f.criticality != null ? ` (criticality ${f.criticality.toFixed(2)})` : "";
      lines.push(`- ${f.name}${c}`);
    }
  }

  return lines.join("\n");
}
