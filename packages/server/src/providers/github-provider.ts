import { createHmac, timingSafeEqual } from "node:crypto";
import type { Platform, PullRequestState } from "../domain/entities.js";
import type {
  CheckAnnotation,
  CheckRunInput,
  DiffFile,
  DiffFileStatus,
  GitProvider,
  InlineCommentInput,
  ProviderComment,
  ProviderPullRequest,
  PullRequestEvent,
  RepoRef,
  WebhookRequest,
  WebhookVerification,
} from "./git-provider.js";
import { type GitHubTokenSource, StaticTokenSource } from "./github-auth.js";
import { type HttpClient, parseJson } from "./http-client.js";

export interface GitHubProviderConfig {
  apiBase: string;
  /** Static PAT/token (back-compat). Ignored when `tokenSource` is set. */
  token?: string;
  webhookSecret: string;
  /** Web host for clone URLs (github.com, or an Enterprise host). */
  webHost?: string;
  /** Live token source (e.g. GitHub App installation tokens). */
  tokenSource?: GitHubTokenSource;
}

interface GhPull {
  number: number;
  title: string;
  state: string;
  merged?: boolean;
  merged_at?: string | null;
  html_url: string;
  user?: { login?: string };
  head: { ref: string; sha: string };
  base: { ref: string };
}

interface GhFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions?: number;
  deletions?: number;
  patch?: string;
}

interface GhComment {
  id: number;
  html_url?: string;
  body?: string;
}

function mapState(p: GhPull): PullRequestState {
  if (p.merged || p.merged_at) return "merged";
  return p.state === "closed" ? "closed" : "open";
}

function mapFileStatus(status: string): DiffFileStatus {
  switch (status) {
    case "added":
      return "added";
    case "removed":
      return "removed";
    case "renamed":
      return "renamed";
    default:
      // modified, changed, copied, unchanged → treat as modified
      return "modified";
  }
}

function toPullRequest(p: GhPull): ProviderPullRequest {
  return {
    number: p.number,
    title: p.title,
    sourceBranch: p.head.ref,
    targetBranch: p.base.ref,
    headSha: p.head.sha,
    author: p.user?.login ?? "",
    url: p.html_url,
    state: mapState(p),
  };
}

function toGhAnnotation(a: CheckAnnotation): Record<string, unknown> {
  return {
    path: a.path,
    start_line: a.startLine,
    end_line: a.endLine,
    annotation_level: a.level,
    message: a.message,
    ...(a.title ? { title: a.title } : {}),
  };
}

/** GitHub adapter for the {@link GitProvider} port (REST v3). */
export class GitHubProvider implements GitProvider {
  readonly platform: Platform = "github";

  private readonly tokens: GitHubTokenSource;

  constructor(
    private readonly http: HttpClient,
    private readonly config: GitHubProviderConfig,
  ) {
    this.tokens = config.tokenSource ?? new StaticTokenSource(config.token ?? "");
  }

  private async headers(repo: RepoRef): Promise<Record<string, string>> {
    const h: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "ReviewPilot",
    };
    const token = await this.tokens.getToken(repo);
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }

  private base(): string {
    return this.config.apiBase.replace(/\/+$/, "");
  }

  verifyWebhook(req: WebhookRequest): WebhookVerification {
    const provided = req.headers["x-hub-signature-256"];
    if (!this.config.webhookSecret) {
      return { valid: false, reason: "no webhook secret configured" };
    }
    if (!provided) {
      return { valid: false, reason: "missing x-hub-signature-256 header" };
    }
    const digest = createHmac("sha256", this.config.webhookSecret)
      .update(req.rawBody)
      .digest("hex");
    const expected = `sha256=${digest}`;
    const a = Buffer.from(expected);
    const b = Buffer.from(provided);
    const valid = a.length === b.length && timingSafeEqual(a, b);
    return valid ? { valid } : { valid: false, reason: "signature mismatch" };
  }

  parseWebhook(req: WebhookRequest): PullRequestEvent | null {
    if (req.headers["x-github-event"] !== "pull_request") return null;
    const payload = JSON.parse(req.rawBody) as {
      action?: string;
      number?: number;
      pull_request?: { number?: number; head?: { sha?: string } };
      repository?: { full_name?: string };
    };
    const number = payload.pull_request?.number ?? payload.number;
    const repoFullName = payload.repository?.full_name;
    const headSha = payload.pull_request?.head?.sha;
    if (number === undefined || !repoFullName || !headSha) return null;
    const action = payload.action ?? "";
    return {
      platform: "github",
      repoFullName,
      number,
      action,
      headSha,
      reviewable: ["opened", "reopened", "synchronize", "ready_for_review"].includes(
        action,
      ),
      closing: action === "closed",
    };
  }

  async getPullRequest(
    repo: RepoRef,
    number: number,
  ): Promise<ProviderPullRequest> {
    const url = `${this.base()}/repos/${repo.fullName}/pulls/${number}`;
    const res = await this.http.request({
      method: "GET",
      url,
      headers: await this.headers(repo),
    });
    return toPullRequest(parseJson<GhPull>(res, url));
  }

  async getPullRequestDiff(
    repo: RepoRef,
    number: number,
  ): Promise<DiffFile[]> {
    const url = `${this.base()}/repos/${repo.fullName}/pulls/${number}/files?per_page=100`;
    const res = await this.http.request({
      method: "GET",
      url,
      headers: await this.headers(repo),
    });
    return parseJson<GhFile[]>(res, url).map((f) => ({
      path: f.filename,
      previousPath: f.previous_filename,
      status: mapFileStatus(f.status),
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch,
    }));
  }

  async listOpenPullRequests(repo: RepoRef): Promise<ProviderPullRequest[]> {
    const url = `${this.base()}/repos/${repo.fullName}/pulls?state=open&per_page=100`;
    const res = await this.http.request({
      method: "GET",
      url,
      headers: await this.headers(repo),
    });
    return parseJson<GhPull[]>(res, url).map(toPullRequest);
  }

  async postComment(
    repo: RepoRef,
    number: number,
    body: string,
  ): Promise<ProviderComment> {
    const url = `${this.base()}/repos/${repo.fullName}/issues/${number}/comments`;
    const res = await this.http.request({
      method: "POST",
      url,
      headers: { ...(await this.headers(repo)), "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    const comment = parseJson<GhComment>(res, url);
    return { id: String(comment.id), url: comment.html_url };
  }

  async listComments(repo: RepoRef, number: number): Promise<ProviderComment[]> {
    const url = `${this.base()}/repos/${repo.fullName}/issues/${number}/comments?per_page=100`;
    const res = await this.http.request({
      method: "GET",
      url,
      headers: await this.headers(repo),
    });
    return parseJson<GhComment[]>(res, url).map((c) => ({
      id: String(c.id),
      url: c.html_url,
      body: c.body,
    }));
  }

  async updateComment(
    repo: RepoRef,
    _number: number,
    commentId: string,
    body: string,
  ): Promise<ProviderComment> {
    const url = `${this.base()}/repos/${repo.fullName}/issues/comments/${commentId}`;
    const res = await this.http.request({
      method: "PATCH",
      url,
      headers: { ...(await this.headers(repo)), "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    const comment = parseJson<GhComment>(res, url);
    return { id: String(comment.id), url: comment.html_url };
  }

  async postInlineComment(
    repo: RepoRef,
    number: number,
    input: InlineCommentInput,
  ): Promise<ProviderComment> {
    const url = `${this.base()}/repos/${repo.fullName}/pulls/${number}/comments`;
    const res = await this.http.request({
      method: "POST",
      url,
      headers: { ...(await this.headers(repo)), "Content-Type": "application/json" },
      body: JSON.stringify({
        body: input.body,
        commit_id: input.commitSha,
        path: input.path,
        line: input.line,
        side: "RIGHT",
      }),
    });
    const comment = parseJson<GhComment>(res, url);
    return { id: String(comment.id), url: comment.html_url };
  }

  async createCheckRun(
    repo: RepoRef,
    input: CheckRunInput,
  ): Promise<ProviderComment> {
    // GitHub accepts at most 50 annotations per request; send the first batch
    // on create and append the rest via follow-up updates.
    const all = input.annotations ?? [];
    const url = `${this.base()}/repos/${repo.fullName}/check-runs`;
    const output = (batch: CheckAnnotation[]) => ({
      title: input.title,
      summary: input.summary,
      annotations: batch.map(toGhAnnotation),
    });
    const res = await this.http.request({
      method: "POST",
      url,
      headers: { ...(await this.headers(repo)), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: input.name,
        head_sha: input.headSha,
        status: "completed",
        conclusion: input.conclusion,
        output: output(all.slice(0, 50)),
      }),
    });
    const check = parseJson<GhComment>(res, url);
    for (let i = 50; i < all.length; i += 50) {
      const updateUrl = `${this.base()}/repos/${repo.fullName}/check-runs/${check.id}`;
      await this.http.request({
        method: "PATCH",
        url: updateUrl,
        headers: { ...(await this.headers(repo)), "Content-Type": "application/json" },
        body: JSON.stringify({ output: output(all.slice(i, i + 50)) }),
      });
    }
    return { id: String(check.id), url: check.html_url };
  }

  async cloneUrl(repo: RepoRef): Promise<string> {
    const host = this.config.webHost ?? "github.com";
    const token = await this.tokens.getToken(repo);
    const auth = token ? `x-access-token:${token}@` : "";
    return `https://${auth}${host}/${repo.fullName}.git`;
  }
}
