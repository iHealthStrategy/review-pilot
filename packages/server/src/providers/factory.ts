import type { AppConfig } from "../config.js";
import type { Platform } from "../domain/entities.js";
import { GitHubAppTokenSource, type GitHubTokenSource } from "./github-auth.js";
import { GitHubProvider } from "./github-provider.js";
import type { GitProvider } from "./git-provider.js";
import { GitLabProvider } from "./gitlab-provider.js";
import { FetchHttpClient, type HttpClient } from "./http-client.js";

export interface GitProviderDeps {
  /** Injectable HTTP client; defaults to the global fetch-backed client. */
  http?: HttpClient;
}

/**
 * Build the {@link GitProvider} for a platform from {@link AppConfig}. The HTTP
 * client is injectable so the same code path is exercised in tests with
 * recorded responses and no credentials.
 */
export function createGitProvider(
  platform: Platform,
  config: AppConfig,
  deps: GitProviderDeps = {},
): GitProvider {
  const http = deps.http ?? new FetchHttpClient();
  switch (platform) {
    case "github": {
      // Prefer GitHub App auth (short-lived installation tokens) when an app id
      // + private key are configured; otherwise fall back to the static PAT.
      let tokenSource: GitHubTokenSource | undefined;
      if (config.github.appId && config.github.appPrivateKey) {
        tokenSource = new GitHubAppTokenSource(http, {
          appId: config.github.appId,
          privateKey: config.github.appPrivateKey,
          apiBase: config.github.apiBase,
          ...(config.github.appInstallationId
            ? { installationId: config.github.appInstallationId }
            : {}),
        });
      }
      return new GitHubProvider(http, {
        apiBase: config.github.apiBase,
        token: config.github.token,
        webhookSecret: config.github.webhookSecret,
        ...(tokenSource ? { tokenSource } : {}),
      });
    }
    case "gitlab":
      return new GitLabProvider(http, {
        apiBase: config.gitlab.apiBase,
        token: config.gitlab.token,
        webhookSecret: config.gitlab.webhookSecret,
      });
    default: {
      const exhaustive: never = platform;
      throw new Error(`Unsupported platform: ${String(exhaustive)}`);
    }
  }
}
