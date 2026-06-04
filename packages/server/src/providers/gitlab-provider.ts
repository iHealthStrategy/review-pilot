import { timingSafeEqual } from "node:crypto";
import type { Platform, PullRequestState } from "../domain/entities.js";
import type {
  DiffFile,
  GitProvider,
  InlineCommentInput,
  ProviderComment,
  ProviderPullRequest,
  PullRequestEvent,
  RepoRef,
  WebhookRequest,
  WebhookVerification,
} from "./git-provider.js";
import { type HttpClient, parseJson } from "./http-client.js";

export interface GitLabProviderConfig {
  apiBase: string;
  token: string;
  webhookSecret: string;
  /** Web host for clone URLs (gitlab.com, or self-managed host). */
  webHost?: string;
}

interface GlMr {
  iid: number;
  title: string;
  state: string;
  web_url: string;
  source_branch: string;
  target_branch: string;
  sha: string;
  author?: { username?: string };
}

interface GlChange {
  old_path: string;
  new_path: string;
  new_file?: boolean;
  deleted_file?: boolean;
  renamed_file?: boolean;
  diff?: string;
}

interface GlNote {
  id: number;
  body?: string;
}

function mapState(state: string): PullRequestState {
  switch (state) {
    case "merged":
      return "merged";
    case "closed":
    case "locked":
      return "closed";
    default:
      return "open"; // "opened"
  }
}

function toPullRequest(m: GlMr): ProviderPullRequest {
  return {
    number: m.iid,
    title: m.title,
    sourceBranch: m.source_branch,
    targetBranch: m.target_branch,
    headSha: m.sha,
    author: m.author?.username ?? "",
    url: m.web_url,
    state: mapState(m.state),
  };
}

/** GitLab adapter for the {@link GitProvider} port (REST v4). */
export class GitLabProvider implements GitProvider {
  readonly platform: Platform = "gitlab";

  constructor(
    private readonly http: HttpClient,
    private readonly config: GitLabProviderConfig,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "User-Agent": "ReviewPilot" };
    if (this.config.token) h["PRIVATE-TOKEN"] = this.config.token;
    return h;
  }

  private base(): string {
    return this.config.apiBase.replace(/\/+$/, "");
  }

  /** GitLab addresses projects by URL-encoded full path. */
  private project(repo: RepoRef): string {
    return encodeURIComponent(repo.fullName);
  }

  verifyWebhook(req: WebhookRequest): WebhookVerification {
    const provided = req.headers["x-gitlab-token"];
    if (!this.config.webhookSecret) {
      return { valid: false, reason: "no webhook secret configured" };
    }
    if (!provided) {
      return { valid: false, reason: "missing x-gitlab-token header" };
    }
    const a = Buffer.from(provided);
    const b = Buffer.from(this.config.webhookSecret);
    const valid = a.length === b.length && timingSafeEqual(a, b);
    return valid ? { valid } : { valid: false, reason: "token mismatch" };
  }

  parseWebhook(req: WebhookRequest): PullRequestEvent | null {
    if (req.headers["x-gitlab-event"] !== "Merge Request Hook") return null;
    const payload = JSON.parse(req.rawBody) as {
      object_kind?: string;
      project?: { path_with_namespace?: string };
      object_attributes?: {
        iid?: number;
        action?: string;
        last_commit?: { id?: string };
      };
    };
    const attrs = payload.object_attributes;
    const repoFullName = payload.project?.path_with_namespace;
    const number = attrs?.iid;
    const headSha = attrs?.last_commit?.id;
    if (number === undefined || !repoFullName || !headSha) return null;
    const action = attrs?.action ?? "";
    return {
      platform: "gitlab",
      repoFullName,
      number,
      action,
      headSha,
      reviewable: ["open", "reopen", "update"].includes(action),
      closing: ["close", "merge"].includes(action),
    };
  }

  async getPullRequest(
    repo: RepoRef,
    number: number,
  ): Promise<ProviderPullRequest> {
    const url = `${this.base()}/projects/${this.project(repo)}/merge_requests/${number}`;
    const res = await this.http.request({
      method: "GET",
      url,
      headers: this.headers(),
    });
    return toPullRequest(parseJson<GlMr>(res, url));
  }

  async getPullRequestDiff(
    repo: RepoRef,
    number: number,
  ): Promise<DiffFile[]> {
    const url = `${this.base()}/projects/${this.project(repo)}/merge_requests/${number}/changes`;
    const res = await this.http.request({
      method: "GET",
      url,
      headers: this.headers(),
    });
    const data = parseJson<{ changes?: GlChange[] }>(res, url);
    return (data.changes ?? []).map((c) => ({
      path: c.new_path,
      previousPath: c.renamed_file ? c.old_path : undefined,
      status: c.new_file
        ? "added"
        : c.deleted_file
          ? "removed"
          : c.renamed_file
            ? "renamed"
            : "modified",
      patch: c.diff,
    }));
  }

  async listOpenPullRequests(repo: RepoRef): Promise<ProviderPullRequest[]> {
    const url = `${this.base()}/projects/${this.project(repo)}/merge_requests?state=opened&per_page=100`;
    const res = await this.http.request({
      method: "GET",
      url,
      headers: this.headers(),
    });
    return parseJson<GlMr[]>(res, url).map(toPullRequest);
  }

  async postComment(
    repo: RepoRef,
    number: number,
    body: string,
  ): Promise<ProviderComment> {
    const url = `${this.base()}/projects/${this.project(repo)}/merge_requests/${number}/notes`;
    const res = await this.http.request({
      method: "POST",
      url,
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    const note = parseJson<GlNote>(res, url);
    return { id: String(note.id) };
  }

  async listComments(repo: RepoRef, number: number): Promise<ProviderComment[]> {
    const url = `${this.base()}/projects/${this.project(repo)}/merge_requests/${number}/notes?per_page=100`;
    const res = await this.http.request({
      method: "GET",
      url,
      headers: this.headers(),
    });
    return parseJson<GlNote[]>(res, url).map((n) => ({
      id: String(n.id),
      body: n.body,
    }));
  }

  async updateComment(
    repo: RepoRef,
    number: number,
    commentId: string,
    body: string,
  ): Promise<ProviderComment> {
    const url = `${this.base()}/projects/${this.project(repo)}/merge_requests/${number}/notes/${commentId}`;
    const res = await this.http.request({
      method: "PUT",
      url,
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    const note = parseJson<GlNote>(res, url);
    return { id: String(note.id) };
  }

  async postInlineComment(
    repo: RepoRef,
    number: number,
    input: InlineCommentInput,
  ): Promise<ProviderComment> {
    const url = `${this.base()}/projects/${this.project(repo)}/merge_requests/${number}/discussions`;
    const res = await this.http.request({
      method: "POST",
      url,
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({
        body: input.body,
        position: {
          position_type: "text",
          new_path: input.path,
          new_line: input.line,
          head_sha: input.commitSha,
        },
      }),
    });
    const note = parseJson<GlNote>(res, url);
    return { id: String(note.id) };
  }

  async cloneUrl(repo: RepoRef): Promise<string> {
    const host = this.config.webHost ?? "gitlab.com";
    const auth = this.config.token ? `oauth2:${this.config.token}@` : "";
    return `https://${auth}${host}/${repo.fullName}.git`;
  }
}
