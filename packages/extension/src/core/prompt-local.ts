import { buildReviewPrompt } from "../../../server/src/review/prompt.js";
import type { ReviewContext } from "../../../server/src/review/review-engine.js";
import type { LocalReviewMode } from "./local-git.js";

const MAX_STRUCTURE_LINES = 400;

/**
 * Pick the prompt for a local review. The `working`/`branch` scopes are exactly
 * the server's diff-oriented review, so they reuse {@link buildReviewPrompt}
 * verbatim. The `full` scope has no diff, so it uses a whole-project variant
 * that keeps the SAME strict JSON output schema (so `parseFindings` still works)
 * but tells the agent to audit the entire checkout rather than a change set.
 */
export function buildLocalPrompt(ctx: ReviewContext, mode: LocalReviewMode): string {
  // Structural context (when present on ctx) is injected by buildReviewPrompt;
  // the full-project variant carries its own structure overview instead.
  if (mode !== "full") return buildReviewPrompt(ctx);
  return buildFullProjectPrompt(ctx);
}

/** Honour REVIEW_LANGUAGE for the human-readable finding fields (as server does). */
function languageInstruction(): string[] {
  const language = (process.env.REVIEW_LANGUAGE ?? "").trim();
  if (!language) return [];
  return [
    "",
    `IMPORTANT: write the "title", "detail" and "suggestion" field VALUES in ${language}. ` +
      "Keep the JSON keys, the severity values, file paths and code identifiers unchanged (do not translate them).",
  ];
}

function renderStructure(structure: string[]): string {
  if (structure.length === 0) return "(empty)";
  if (structure.length <= MAX_STRUCTURE_LINES) return structure.join("\n");
  const shown = structure.slice(0, MAX_STRUCTURE_LINES).join("\n");
  return `${shown}\n… and ${structure.length - MAX_STRUCTURE_LINES} more files`;
}

function buildFullProjectPrompt(ctx: ReviewContext): string {
  return [
    "You are an expert code reviewer auditing an ENTIRE project for issues.",
    "You are running inside a full checkout of the repository (your current",
    "working directory), so you SHOULD open and read files to understand the code",
    "before judging it. Look for correctness bugs, security vulnerabilities,",
    "performance problems, and serious maintainability issues anywhere in the",
    "codebase — there is no diff; the whole project is in scope.",
    "",
    `Repository: ${ctx.repoFullName}`,
    ...(ctx.projectInsight
      ? ["", "## Project understanding (cached)", ctx.projectInsight]
      : []),
    ...(ctx.reviewFocus && ctx.reviewFocus.trim()
      ? [
          "",
          "## Review focus (requested emphasis)",
          "Prioritise findings related to the following (still report other",
          "serious issues you notice):",
          ctx.reviewFocus.trim(),
        ]
      : []),
    "",
    "## Repository structure (overview)",
    renderStructure(ctx.structure),
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
    "Focus on real, actionable issues. Prefer fewer high-quality findings over",
    "noise. If there are no issues, respond with an empty array: []",
    ...languageInstruction(),
  ].join("\n");
}
