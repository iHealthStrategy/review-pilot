import type { PullRequest, Repo } from "../domain/entities.js";
import type { GitProvider } from "../providers/git-provider.js";
import type { Cloner, Workspace } from "./cloner.js";
import type { ReviewContext } from "./review-engine.js";
import { scanStructure } from "./structure-scanner.js";

export interface ContextBuilderDeps {
  provider: GitProvider;
  cloner: Cloner;
  /** Structure scanner; defaults to the filesystem walker. */
  scan?: (dir: string) => Promise<string[]>;
}

/**
 * Sync the full repository at the PR head and assemble a {@link ReviewContext}
 * that pairs the overall structure with this PR's diff. Returns the workspace
 * so the caller can clean it up after the engine runs.
 */
export async function buildReviewContext(
  deps: ContextBuilderDeps,
  repo: Repo,
  pr: PullRequest,
): Promise<{ context: ReviewContext; workspace: Workspace }> {
  const repoRef = { fullName: repo.fullName };
  const cloneUrl = await deps.provider.cloneUrl(repoRef);
  const workspace = await deps.cloner.clone(cloneUrl, pr.headSha);
  const scan = deps.scan ?? scanStructure;
  const structure = await scan(workspace.dir);
  const diff = await deps.provider.getPullRequestDiff(repoRef, pr.number);

  const context: ReviewContext = {
    platform: repo.platform,
    repoFullName: repo.fullName,
    pullRequest: {
      number: pr.number,
      title: pr.title,
      sourceBranch: pr.sourceBranch,
      targetBranch: pr.targetBranch,
      headSha: pr.headSha,
      author: pr.author,
      url: pr.url,
    },
    structure,
    diff,
    workspaceDir: workspace.dir,
  };
  return { context, workspace };
}
