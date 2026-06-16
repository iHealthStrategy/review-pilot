import { type CommandRunner, ProcessCommandRunner } from "./command-runner.js";
import { changedRanges } from "./diff-lines.js";
import type { GraphCacheService, RepoIdentity } from "./graph-cache.js";
import type { ReviewContext } from "./review-engine.js";
import { renderStructuralContext } from "./structural-context.js";

export interface StructuralReviewDeps {
  /** Shared per-repo base-graph cache (read-only query per PR). */
  cache: GraphCacheService;
  /** Identity + clone URL of the repo under review (for the base-graph cache). */
  repo: RepoIdentity;
  /** Runs git in the PR workspace to read the base tip (defaults to a real runner). */
  commandRunner?: CommandRunner;
  onLog?: (message: string) => void;
}

/**
 * Produce the rendered structural-context section for a PR review, or undefined
 * when it can't be computed. Reuses the repo's shared base graph (built/
 * refreshed once, queried read-only here) and maps THIS PR's changed line
 * ranges onto it — so concurrent PRs on the same repo all query in parallel
 * with no rebuild. Best-effort: any miss yields undefined and the review
 * proceeds on the diff + structure overview alone.
 */
export async function ensureStructuralContext(
  ctx: ReviewContext,
  deps: StructuralReviewDeps,
): Promise<string | undefined> {
  const log = deps.onLog ?? (() => {});
  const runner = deps.commandRunner ?? new ProcessCommandRunner();

  // The PR workspace already fetched origin/<base>; reading its tip is free and
  // lets the cache refresh when base has advanced (no extra network call).
  const baseSha = await workspaceBaseSha(runner, ctx.workspaceDir, deps.repo.baseBranch);
  const ref = await deps.cache.ensureBaseGraph(deps.repo, baseSha);
  if (!ref) return undefined;

  const ranges = changedRanges(ctx.diff);
  const changedFiles = ctx.diff.map((d) => d.path);
  if (changedFiles.length === 0) return undefined;

  const sc = await deps.cache.query(ref, changedFiles, ranges);
  if (!sc) return undefined;

  log(`Structural context: risk ${sc.riskScore.toFixed(2)}, ${sc.testGaps.length} test gap(s).`);
  // Graph node paths live under the cache checkout; render relative to it so
  // they come out repo-relative (identical layout to the PR workspace).
  return renderStructuralContext(sc, ref.srcRoot);
}

/** Base-branch tip as seen in the PR workspace, or undefined (→ TTL-only freshness). */
async function workspaceBaseSha(
  runner: CommandRunner,
  workspaceDir: string,
  baseBranch: string,
): Promise<string | undefined> {
  const res = await runner.run("git", [
    "-C", workspaceDir, "rev-parse", `origin/${baseBranch}`,
  ]);
  const sha = res.stdout.trim();
  return res.code === 0 && sha ? sha : undefined;
}
