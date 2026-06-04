import type { Platform } from "../src/domain/entities.js";
import type {
  CheckRunInput,
  DiffFile,
  GitProvider,
  InlineCommentInput,
  ProviderComment,
  ProviderPullRequest,
  PullRequestEvent,
  RepoRef,
  WebhookRequest,
  WebhookVerification,
} from "../src/providers/git-provider.js";

/**
 * Recording {@link GitProvider} test double: returns canned PR/diff and records
 * every write-back, so Worker tests can assert that summary/inline comments are
 * posted — with no network and no credentials.
 */
export class SpyProvider implements GitProvider {
  readonly platform: Platform;
  comments: { number: number; body: string }[] = [];
  inline: { number: number; input: InlineCommentInput }[] = [];
  checkRuns: CheckRunInput[] = [];
  /** Throw from getPullRequestDiff this many times, then succeed (for retry tests). */
  failDiffTimes = 0;

  constructor(
    platform: Platform = "github",
    private readonly diff: DiffFile[] = [
      { path: "src/new.ts", status: "added" },
      { path: "src/mod.ts", status: "modified" },
    ],
  ) {
    this.platform = platform;
  }

  verifyWebhook(_req: WebhookRequest): WebhookVerification {
    return { valid: true };
  }

  parseWebhook(_req: WebhookRequest): PullRequestEvent | null {
    return null;
  }

  async getPullRequest(_repo: RepoRef, number: number): Promise<ProviderPullRequest> {
    return {
      number,
      title: "Add feature",
      sourceBranch: "feat",
      targetBranch: "main",
      headSha: "abc123",
      author: "alice",
      url: `https://example/pr/${number}`,
      state: "open",
    };
  }

  async getPullRequestDiff(_repo: RepoRef, _number: number): Promise<DiffFile[]> {
    if (this.failDiffTimes > 0) {
      this.failDiffTimes -= 1;
      throw new Error("simulated diff fetch failure");
    }
    return this.diff;
  }

  async listOpenPullRequests(_repo: RepoRef): Promise<ProviderPullRequest[]> {
    return [];
  }

  async postComment(
    _repo: RepoRef,
    number: number,
    body: string,
  ): Promise<ProviderComment> {
    this.comments.push({ number, body });
    return { id: `c${this.comments.length}` };
  }

  async postInlineComment(
    _repo: RepoRef,
    number: number,
    input: InlineCommentInput,
  ): Promise<ProviderComment> {
    this.inline.push({ number, input });
    return { id: `ic${this.inline.length}` };
  }

  async createCheckRun(_repo: RepoRef, input: CheckRunInput): Promise<ProviderComment> {
    this.checkRuns.push(input);
    return { id: `chk${this.checkRuns.length}` };
  }

  async cloneUrl(repo: RepoRef): Promise<string> {
    return `https://example/${repo.fullName}.git`;
  }
}
