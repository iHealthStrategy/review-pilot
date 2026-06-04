import { createSign } from "node:crypto";
import type { RepoRef } from "./git-provider.js";
import { type HttpClient, parseJson } from "./http-client.js";

/**
 * Source of a GitHub token valid for both API calls and cloning a given repo.
 * Abstracts the two auth modes: a static PAT, or short-lived GitHub App
 * installation tokens that must be minted from the App's private key and
 * refreshed before they expire.
 */
export interface GitHubTokenSource {
  getToken(repo: RepoRef): Promise<string>;
}

/** Personal-access-token / static-token source (token may be empty = anon). */
export class StaticTokenSource implements GitHubTokenSource {
  constructor(private readonly token: string) {}
  async getToken(): Promise<string> {
    return this.token;
  }
}

export interface GitHubAppConfig {
  appId: string;
  /** App private key in PEM (RSA). */
  privateKey: string;
  apiBase: string;
  /** Fixed installation id; when omitted it is resolved per repo and cached. */
  installationId?: string;
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

interface InstallationTokenResponse {
  token: string;
  expires_at: string;
}

const REFRESH_SKEW_MS = 60_000;

/**
 * Mints and caches GitHub App installation access tokens. It signs a short
 * App JWT (RS256, via node:crypto — no extra dependency), resolves the
 * installation for a repo when not pinned, exchanges the JWT for an
 * installation token, and caches it per installation until shortly before it
 * expires. This is the production-grade GitHub auth path: fine-grained,
 * per-installation, higher rate limits.
 */
export class GitHubAppTokenSource implements GitHubTokenSource {
  private readonly tokens = new Map<string, CachedToken>();
  private readonly installationByRepo = new Map<string, string>();

  constructor(
    private readonly http: HttpClient,
    private readonly config: GitHubAppConfig,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  async getToken(repo: RepoRef): Promise<string> {
    const installationId = await this.resolveInstallation(repo);
    const cached = this.tokens.get(installationId);
    if (cached && cached.expiresAtMs - REFRESH_SKEW_MS > this.nowMs()) {
      return cached.token;
    }
    const minted = await this.mintInstallationToken(installationId);
    this.tokens.set(installationId, minted);
    return minted.token;
  }

  /** Build a signed App JWT (valid ~9 min) used for App-level API calls. */
  buildAppJwt(): string {
    const nowSec = Math.floor(this.nowMs() / 1000);
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = b64url(
      JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: this.config.appId }),
    );
    const signingInput = `${header}.${payload}`;
    const signature = createSign("RSA-SHA256")
      .update(signingInput)
      .sign(this.config.privateKey)
      .toString("base64url");
    return `${signingInput}.${signature}`;
  }

  private appHeaders(): Record<string, string> {
    return {
      Accept: "application/vnd.github+json",
      "User-Agent": "ReviewPilot",
      Authorization: `Bearer ${this.buildAppJwt()}`,
    };
  }

  private base(): string {
    return this.config.apiBase.replace(/\/+$/, "");
  }

  private async resolveInstallation(repo: RepoRef): Promise<string> {
    if (this.config.installationId) return this.config.installationId;
    const cached = this.installationByRepo.get(repo.fullName);
    if (cached) return cached;
    const url = `${this.base()}/repos/${repo.fullName}/installation`;
    const res = await this.http.request({ method: "GET", url, headers: this.appHeaders() });
    const data = parseJson<{ id: number }>(res, url);
    const id = String(data.id);
    this.installationByRepo.set(repo.fullName, id);
    return id;
  }

  private async mintInstallationToken(installationId: string): Promise<CachedToken> {
    const url = `${this.base()}/app/installations/${installationId}/access_tokens`;
    const res = await this.http.request({
      method: "POST",
      url,
      headers: { ...this.appHeaders(), "Content-Type": "application/json" },
    });
    const data = parseJson<InstallationTokenResponse>(res, url);
    return { token: data.token, expiresAtMs: Date.parse(data.expires_at) };
  }
}

function b64url(s: string): string {
  return Buffer.from(s).toString("base64url");
}
