import type { Platform, ReviewEngineKind } from "../domain/entities.js";
import type { AddFindingInput } from "../persistence/repository.js";
import type { DiffFile } from "../providers/git-provider.js";

/**
 * Everything a review engine needs: the PR being reviewed, this PR's diff, AND
 * the full-repository structure — so engines can review "in the context of the
 * whole codebase", not just the changed lines.
 */
export interface ReviewContext {
  platform: Platform;
  repoFullName: string;
  pullRequest: {
    number: number;
    title: string;
    sourceBranch: string;
    targetBranch: string;
    headSha: string;
    author: string;
    url: string;
  };
  /** Repo-relative paths of every file in the synced workspace. */
  structure: string[];
  /** Files changed by this PR. */
  diff: DiffFile[];
  /** Absolute path to the synced full repository. */
  workspaceDir: string;
  /** Cached whole-project understanding to ground the review (optional). */
  projectInsight?: string;
  /**
   * Pre-rendered structural-context section (risk-scored hotspots, test gaps,
   * affected flows) from the code-review-graph. Injected verbatim into the
   * prompt when present. Absent → review relies on the diff + structure only.
   */
  structuralContext?: string;
  /**
   * Reviewer-supplied emphasis for this review (e.g. "focus on SQL injection
   * and N+1 queries"). When set, the engine is told to prioritise these points.
   * Empty/absent → the default general review.
   */
  reviewFocus?: string;
}

/** A produced finding before it is persisted (no id/job yet). */
export type FindingDraft = AddFindingInput;

/**
 * Pluggable review engine. The default is the credential-free mock; Cursor /
 * Claude Code / Codex are CLI-backed adapters selected by configuration.
 */
export interface ReviewEngine {
  readonly kind: ReviewEngineKind;
  review(ctx: ReviewContext): Promise<FindingDraft[]>;
  /**
   * Produce a concise whole-project understanding summary (plain text) by
   * exploring the synced checkout. Optional: only agentic engines that can read
   * the repo implement it; it powers the per-repo insight cache.
   */
  summarize?(ctx: ReviewContext): Promise<string>;
}
