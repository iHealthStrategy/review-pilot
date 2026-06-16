import type { Severity } from "../domain/entities.js";
import type { DiffFile } from "../providers/git-provider.js";
import type { FindingDraft, ReviewContext } from "./review-engine.js";

const SEVERITIES: ReadonlySet<Severity> = new Set([
  "info",
  "minor",
  "major",
  "critical",
]);

/** Shape an external review CLI is asked to emit (one per finding). */
interface RawFinding {
  filePath?: string;
  file?: string;
  path?: string;
  line?: number;
  endLine?: number;
  severity?: string;
  title?: string;
  detail?: string;
  message?: string;
  suggestion?: string;
  category?: string;
}

const MAX_STRUCTURE_LINES = 400;
const MAX_DIFF_CHARS = 60000;

/**
 * Build the review prompt handed to an external CLI (Claude Code / Cursor /
 * Codex). The agent runs INSIDE the synced full repository (its cwd), so it can
 * open any file for context; we give it the PR metadata, a structure overview
 * and the actual diff, and pin the output to a strict JSON schema so the result
 * is machine-parseable regardless of which tool produced it.
 */
export function buildReviewPrompt(ctx: ReviewContext): string {
  const pr = ctx.pullRequest;
  const structure = renderStructure(ctx.structure);
  const diff = renderDiff(ctx.diff);

  return [
    "You are an expert code reviewer. Review the following pull request for",
    "correctness bugs, security issues, performance problems, and maintainability.",
    "You are running inside a full checkout of the repository at the PR's head",
    "commit (your current working directory), so you MAY open and read any file",
    "in the project to understand context beyond the diff.",
    "",
    `Repository: ${ctx.repoFullName} (${ctx.platform})`,
    `Pull request #${pr.number}: ${pr.title}`,
    `Branch ${pr.sourceBranch} → ${pr.targetBranch} @ ${pr.headSha}`,
    `Author: ${pr.author}`,
    "",
    ...(ctx.projectInsight
      ? ["## Project understanding (cached)", ctx.projectInsight, ""]
      : []),
    ...(ctx.reviewFocus && ctx.reviewFocus.trim()
      ? [
          "## Review focus (requested emphasis)",
          "The requester asked you to pay SPECIAL attention to the following.",
          "Prioritise findings related to these points (still report other",
          "serious issues you notice):",
          ctx.reviewFocus.trim(),
          "",
        ]
      : []),
    ...(ctx.structuralContext ? [ctx.structuralContext, ""] : []),
    "## Repository structure (overview)",
    structure,
    "",
    "## Changed files (diff)",
    diff,
    "",
    "## Output format (STRICT)",
    "Respond with ONLY a JSON array — no prose, no markdown fences. Each element:",
    "{",
    '  "filePath": "<repo-relative path>",',
    '  "line": <1-based line number, optional>,',
    '  "endLine": <optional>,',
    '  "severity": "info" | "minor" | "major" | "critical",',
    '  "title": "<short summary>",',
    '  "detail": "<explanation of the problem>",',
    '  "suggestion": "<concrete fix, optional>",',
    '  "category": "<e.g. correctness|security|performance|style, optional>"',
    "}",
    "Only report issues introduced or affected by this PR. If there are no issues,",
    "respond with an empty array: []",
    ...languageInstruction(),
  ].join("\n");
}

/** Optional language directive for the human-readable finding fields. */
function languageInstruction(): string[] {
  const language = (process.env.REVIEW_LANGUAGE ?? "").trim();
  if (!language) return [];
  return [
    "",
    `IMPORTANT: write the "title", "detail" and "suggestion" field VALUES in ${language}. ` +
      "Keep the JSON keys, the severity values, file paths and code identifiers unchanged (do not translate them).",
  ];
}

/**
 * Prompt for generating a cached whole-project understanding. The agent runs
 * in the checkout and explores it; the output is reused across PR reviews.
 */
export function buildProjectSummaryPrompt(ctx: ReviewContext): string {
  return [
    "You are onboarding onto a codebase to enable high-quality code review.",
    "You are running inside a full checkout (your current working directory);",
    "explore it (read key files, configs, entry points) and produce a concise",
    "but information-dense understanding of the PROJECT AS A WHOLE.",
    "",
    `Repository: ${ctx.repoFullName} (${ctx.platform})`,
    "",
    "## Repository structure (overview)",
    renderStructure(ctx.structure),
    "",
    "## Output",
    "Write plain prose (no JSON), <= ~400 words, covering: purpose, main",
    "modules/packages and their responsibilities, key architectural patterns and",
    "conventions, important invariants/constraints, and anything a reviewer must",
    "keep in mind. This will be cached and given to future PR reviews as context.",
    ...languageInstruction(),
  ].join("\n");
}

function renderStructure(structure: string[]): string {
  if (structure.length === 0) return "(empty)";
  if (structure.length <= MAX_STRUCTURE_LINES) return structure.join("\n");
  const shown = structure.slice(0, MAX_STRUCTURE_LINES).join("\n");
  return `${shown}\n… and ${structure.length - MAX_STRUCTURE_LINES} more files`;
}

function renderDiff(diff: DiffFile[]): string {
  if (diff.length === 0) return "(no file changes)";
  let out = "";
  for (const f of diff) {
    const header =
      `### ${f.path}${f.previousPath ? ` (was ${f.previousPath})` : ""} ` +
      `[${f.status}${f.additions != null ? ` +${f.additions}` : ""}` +
      `${f.deletions != null ? ` -${f.deletions}` : ""}]`;
    const body = f.patch ? `\n\`\`\`diff\n${f.patch}\n\`\`\`` : "\n(no patch text available)";
    const next = `${header}${body}\n`;
    if (out.length + next.length > MAX_DIFF_CHARS) {
      out += `\n… diff truncated (${diff.length} files total) …\n`;
      break;
    }
    out += next;
  }
  return out;
}

/**
 * Extract structured findings from an external CLI's stdout. Tolerant of agents
 * that wrap the JSON in prose or markdown fences: it strips code fences, then
 * scans for the first balanced JSON array (or a `{ "findings": [...] }`
 * object), parses it and normalises each entry into a {@link FindingDraft}.
 * Throws only when no JSON array can be found at all.
 */
export function parseFindings(stdout: string): FindingDraft[] {
  const raw = extractFindingsArray(stdout);
  return raw.map(normalise);
}

function extractFindingsArray(stdout: string): RawFinding[] {
  const cleaned = stripFences(stdout).trim();
  if (cleaned === "") return [];

  // Try the whole payload first (array, or { findings: [...] }).
  const whole = tryParse(cleaned);
  if (whole) return whole;

  // Otherwise scan for the first balanced top-level array.
  const slice = firstBalancedArray(cleaned);
  if (slice) {
    const parsed = tryParse(slice);
    if (parsed) return parsed;
  }
  throw new Error("review engine produced no parseable JSON findings array");
}

function tryParse(text: string): RawFinding[] | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (Array.isArray(value)) return value as RawFinding[];
    if (
      value &&
      typeof value === "object" &&
      Array.isArray((value as { findings?: unknown }).findings)
    ) {
      return (value as { findings: RawFinding[] }).findings;
    }
    return null;
  } catch {
    return null;
  }
}

/** Strip ```json … ``` / ``` … ``` fences while preserving inner content. */
function stripFences(text: string): string {
  return text.replace(/```(?:json)?\s*([\s\S]*?)```/g, "$1");
}

/** Return the first balanced `[...]` substring, respecting string literals. */
function firstBalancedArray(text: string): string | null {
  const start = text.indexOf("[");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function normalise(r: RawFinding): FindingDraft {
  const severity =
    r.severity && SEVERITIES.has(r.severity as Severity)
      ? (r.severity as Severity)
      : "info";
  return {
    filePath: r.filePath ?? r.file ?? r.path ?? "<unknown>",
    line: r.line,
    endLine: r.endLine,
    severity,
    title: r.title ?? r.message ?? "Finding",
    detail: r.detail ?? r.message ?? "",
    suggestion: r.suggestion,
    category: r.category,
  };
}
