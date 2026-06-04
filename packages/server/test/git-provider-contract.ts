import assert from "node:assert/strict";
import { test } from "node:test";
import type { DiffFile, GitProvider, RepoRef } from "../src/providers/git-provider.js";

export interface ProviderContractCase {
  provider: GitProvider;
  repo: RepoRef;
}

/**
 * Cross-platform parity contract. Each platform seeds its own fixtures, but
 * every adapter MUST normalise them into the identical platform-neutral shape
 * asserted here — that is the whole point of the {@link GitProvider} port.
 *
 * The canonical scenario is MR/PR #7 "Add feature" (feat → main, @alice,
 * sha=abc123, open) with an added / modified / renamed file.
 */
export function runGitProviderContract(
  name: string,
  makeCase: () => ProviderContractCase,
): void {
  test(`${name}: getPullRequest normalises metadata`, async () => {
    const { provider, repo } = makeCase();
    const pr = await provider.getPullRequest(repo, 7);
    assert.equal(pr.number, 7);
    assert.equal(pr.title, "Add feature");
    assert.equal(pr.sourceBranch, "feat");
    assert.equal(pr.targetBranch, "main");
    assert.equal(pr.headSha, "abc123");
    assert.equal(pr.author, "alice");
    assert.equal(pr.state, "open");
    assert.ok(pr.url.length > 0);
  });

  test(`${name}: getPullRequestDiff normalises file statuses`, async () => {
    const { provider, repo } = makeCase();
    const diff = await provider.getPullRequestDiff(repo, 7);
    const byPath = new Map(diff.map((f: DiffFile) => [f.path, f]));
    assert.equal(byPath.get("src/new.ts")?.status, "added");
    assert.equal(byPath.get("src/mod.ts")?.status, "modified");
    const renamed = byPath.get("src/renamed.ts");
    assert.equal(renamed?.status, "renamed");
    assert.equal(renamed?.previousPath, "src/old.ts");
  });

  test(`${name}: listOpenPullRequests returns normalised open PRs`, async () => {
    const { provider, repo } = makeCase();
    const open = await provider.listOpenPullRequests(repo);
    assert.equal(open.length, 1);
    assert.equal(open[0]?.number, 7);
    assert.equal(open[0]?.state, "open");
  });

  test(`${name}: postComment returns a comment id`, async () => {
    const { provider, repo } = makeCase();
    const comment = await provider.postComment(repo, 7, "LGTM with notes");
    assert.ok(comment.id.length > 0);
  });

  test(`${name}: cloneUrl targets the repository`, async () => {
    const { provider, repo } = makeCase();
    const url = await provider.cloneUrl(repo);
    assert.match(url, /^https:\/\//);
    assert.ok(url.includes(`${repo.fullName}.git`));
  });
}
