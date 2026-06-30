/**
 * Centralised, validated runtime configuration.
 *
 * The whole platform is config-driven (DB driver, review engine, git
 * providers, polling). This module is the single source of truth; everything
 * else receives an immutable {@link AppConfig} rather than reading
 * `process.env` directly, which keeps the system testable in `mock` mode with
 * no external credentials.
 */

import type { UserRole } from "./domain/entities.js";
import { parseGroupRoleMap } from "./auth/oidc.js";

export type DbDriver = "mock" | "sqlite" | "postgres" | "mongo";
export type ReviewEngineKind =
  | "mock"
  | "cursor"
  | "claude-code"
  | "claude-agent"
  | "codex";

export interface AppConfig {
  readonly port: number;
  readonly logLevel: string;
  readonly db: {
    readonly driver: DbDriver;
    readonly sqlitePath: string;
    readonly databaseUrl: string;
    /** Mongo connection string (when driver=mongo); carries auth/credentials. */
    readonly mongoUri: string;
    /** Mongo database name (when driver=mongo). */
    readonly mongoDb: string;
  };
  readonly review: {
    readonly defaultEngine: ReviewEngineKind;
    readonly enabledEngines: ReviewEngineKind[];
    /** Override the external engine executable (else per-engine default). */
    readonly engineCommand: string;
    /** Override the external engine args (whitespace-separated env value). */
    readonly engineArgs: string[];
    /** Model for the Agent SDK engine (empty = SDK default). */
    readonly agentModel: string;
    /** Max agent turns for the Agent SDK engine. */
    readonly agentMaxTurns: number;
    /** Maintain a per-repo project-understanding cache to ground reviews. */
    readonly projectInsight: boolean;
    /** Regenerate the cached understanding when older than this (ms). */
    readonly insightTtlMs: number;
    /** Keep only findings on lines the PR changed (noise reduction). */
    readonly onlyChangedLines: boolean;
    /**
     * Enrich the prompt with code-review-graph structural analysis (risk-scored
     * hotspots, test gaps, affected flows). Requires the `code-review-graph`
     * package reachable via {@link codeGraphLauncher}; best-effort otherwise.
     */
    readonly structuralContext: boolean;
    /** Launcher exposing the `code-review-graph` package on PATH (e.g. "uvx"). */
    readonly codeGraphLauncher: string;
    /** Root dir for the per-repo base-graph cache (empty → ./data/graph-cache). */
    readonly codeGraphCacheDir: string;
    /** Rebuild a repo's cached base graph once older than this (ms). */
    readonly codeGraphTtlMs: number;
  };
  readonly github: {
    readonly apiBase: string;
    readonly token: string;
    readonly webhookSecret: string;
    /** GitHub App id (enables App auth when set with a private key). */
    readonly appId: string;
    /** GitHub App private key (PEM); `\n`-escaped newlines are unescaped. */
    readonly appPrivateKey: string;
    /** Optional fixed installation id; resolved per repo when empty. */
    readonly appInstallationId: string;
  };
  readonly gitlab: {
    readonly apiBase: string;
    readonly token: string;
    readonly webhookSecret: string;
  };
  readonly trigger: {
    readonly pollIntervalSeconds: number;
  };
  readonly worker: {
    /**
     * On startup, requeue jobs left in `running` by a previous (crashed or
     * redeployed) container so a restarted stateless service resumes cleanly.
     * Assumes a single active worker; disable for multi-worker deployments
     * that rely on lease-based recovery instead.
     */
    readonly recoverInterruptedJobsOnStart: boolean;
    /** Also post line-level PR comments for findings that carry a line. */
    readonly inlineComments: boolean;
    /** Hard timeout for an external review CLI invocation (ms). */
    readonly engineTimeoutMs: number;
    /** Publish a Check Run (with inline annotations) on each review. */
    readonly publishCheckRun: boolean;
    /** Gate threshold: Check Run fails at this severity or worse ("" = off). */
    readonly failOnSeverity: string;
  };
  readonly schedule: {
    /**
     * JSON file backing the lightweight schedule store when the DB driver is
     * not `mongo`. Persists scheduled-scan configs across restarts; put it on a
     * volume for stateless deploys, or use the `mongo` driver for DB-backed.
     */
    readonly storeFile: string;
    /**
     * Default Feishu webhook URL for scheduled-scan delivery. Used when a
     * schedule doesn't specify its own `delivery.webhookUrl`, so the push
     * target can be set once at deploy time instead of per-schedule.
     */
    readonly feishuWebhookUrl: string;
  };
  /**
   * Signing secret for session tokens. When set, the management API/UI requires
   * a logged-in user (or a personal access token); empty disables auth (dev only).
   * Must be a stable, shared value across replicas so sessions survive restarts.
   */
  readonly sessionSecret: string;
  /** Session token lifetime in ms (default 7 days). */
  readonly sessionTtlMs: number;
  /**
   * Built-in admin configured from the environment — NOT stored in the DB and
   * needs no maintenance. Enabled only when `adminToken` is set. Acts as a
   * token-only break-glass admin for the API/MCP (interactive login is delegated
   * to the OIDC provider; there is no env-admin password login).
   */
  readonly adminEmail: string;
  /**
   * Optional config-only PAT for the env admin. When set, a request bearing this
   * token authenticates as the env admin (admin role) without a DB row — lets the
   * env admin drive the API / MCP / skill auto-grow. Break-glass; keep it secret.
   */
  readonly adminToken: string;
  /**
   * Public base URL of this service (scheme://host, no trailing slash). Used for
   * the OIDC redirect URI and self-referential links; preferred over request
   * headers (avoids Host-header spoofing). Empty falls back to the request origin.
   */
  readonly publicBaseUrl: string;
  /**
   * OpenID Connect (e.g. authentik). When `issuer` + `clientId` are set,
   * interactive authentication is delegated to the IdP and local password login
   * is disabled; this app keeps only authorization (role config).
   */
  readonly oidc: {
    readonly issuer: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly scopes: string;
    readonly groupsClaim: string;
    readonly groupRoleMap: Record<string, UserRole>;
    readonly apiUrl: string;
    readonly apiToken: string;
  };
  /** Directory of the built Web UI to serve; empty uses the bundled default. */
  readonly webDistDir: string;
  readonly workspaceDir: string;
}

const DB_DRIVERS: readonly DbDriver[] = ["mock", "sqlite", "postgres", "mongo"];
const ENGINES: readonly ReviewEngineKind[] = [
  "mock",
  "cursor",
  "claude-code",
  "claude-agent",
  "codex",
];

function str(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const v = env[key];
  return v === undefined || v === "" ? fallback : v;
}

function int(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) {
    throw new Error(`Invalid integer for ${key}: ${JSON.stringify(raw)}`);
  }
  return n;
}

const SEVERITIES: readonly string[] = ["info", "minor", "major", "critical"];

function severityOrEmpty(env: NodeJS.ProcessEnv, key: string): string {
  const v = str(env, key, "");
  if (v === "") return "";
  if (!SEVERITIES.includes(v)) {
    throw new Error(`Invalid ${key}: ${JSON.stringify(v)}. Expected one of ${SEVERITIES.join(", ")}.`);
  }
  return v;
}

function bool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function oneOf<T extends string>(
  env: NodeJS.ProcessEnv,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const v = str(env, key, fallback) as T;
  if (!allowed.includes(v)) {
    throw new Error(
      `Invalid ${key}: ${JSON.stringify(v)}. Expected one of ${allowed.join(", ")}.`,
    );
  }
  return v;
}

function engineList(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: ReviewEngineKind[],
): ReviewEngineKind[] {
  const raw = str(env, key, "");
  if (raw === "") return fallback;
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  for (const p of parts) {
    if (!ENGINES.includes(p as ReviewEngineKind)) {
      throw new Error(
        `Invalid engine in ${key}: ${JSON.stringify(p)}. Expected one of ${ENGINES.join(", ")}.`,
      );
    }
  }
  return parts as ReviewEngineKind[];
}

/**
 * Build an {@link AppConfig} from an environment-like object. Pass an explicit
 * object in tests; defaults to `process.env`.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const defaultEngine = oneOf(env, "REVIEW_ENGINE", ENGINES, "mock");
  const enabledEngines = engineList(env, "REVIEW_ENGINES_ENABLED", [
    "mock",
  ]);
  if (!enabledEngines.includes(defaultEngine)) {
    enabledEngines.unshift(defaultEngine);
  }

  return {
    port: int(env, "PORT", 3000),
    logLevel: str(env, "LOG_LEVEL", "info"),
    db: {
      driver: oneOf(env, "DB_DRIVER", DB_DRIVERS, "mock"),
      sqlitePath: str(env, "DB_SQLITE_PATH", "./data/reviewpilot.db"),
      databaseUrl: str(env, "DATABASE_URL", ""),
      mongoUri: str(env, "MONGODB_URI", ""),
      mongoDb: str(env, "MONGODB_DB", "reviewpilot"),
    },
    review: {
      defaultEngine,
      enabledEngines,
      engineCommand: str(env, "REVIEW_ENGINE_COMMAND", ""),
      engineArgs: str(env, "REVIEW_ENGINE_ARGS", "")
        .split(/\s+/)
        .filter((s) => s.length > 0),
      agentModel: str(env, "REVIEW_AGENT_MODEL", ""),
      agentMaxTurns: int(env, "REVIEW_AGENT_MAX_TURNS", 30),
      projectInsight: bool(env, "PROJECT_INSIGHT_CACHE", true),
      insightTtlMs: int(env, "PROJECT_INSIGHT_TTL_MS", 604800000),
      onlyChangedLines: bool(env, "ONLY_CHANGED_LINES", false),
      structuralContext: bool(env, "STRUCTURAL_CONTEXT", true),
      codeGraphLauncher: str(env, "CODE_GRAPH_LAUNCHER", "uvx"),
      codeGraphCacheDir: str(env, "CODE_GRAPH_CACHE_DIR", ""),
      codeGraphTtlMs: int(env, "CODE_GRAPH_TTL_MS", 3600000),
    },
    github: {
      apiBase: str(env, "GITHUB_API_BASE", "https://api.github.com"),
      token: str(env, "GITHUB_TOKEN", ""),
      webhookSecret: str(env, "GITHUB_WEBHOOK_SECRET", ""),
      appId: str(env, "GITHUB_APP_ID", ""),
      appPrivateKey: str(env, "GITHUB_APP_PRIVATE_KEY", "").replace(/\\n/g, "\n"),
      appInstallationId: str(env, "GITHUB_APP_INSTALLATION_ID", ""),
    },
    gitlab: {
      apiBase: str(env, "GITLAB_API_BASE", "https://gitlab.com/api/v4"),
      token: str(env, "GITLAB_TOKEN", ""),
      webhookSecret: str(env, "GITLAB_WEBHOOK_SECRET", ""),
    },
    trigger: {
      pollIntervalSeconds: int(env, "POLL_INTERVAL_SECONDS", 0),
    },
    worker: {
      recoverInterruptedJobsOnStart: bool(
        env,
        "RECOVER_INTERRUPTED_JOBS_ON_START",
        true,
      ),
      inlineComments: bool(env, "INLINE_COMMENTS", false),
      engineTimeoutMs: int(env, "ENGINE_TIMEOUT_MS", 600000),
      publishCheckRun: bool(env, "PUBLISH_CHECK_RUN", true),
      failOnSeverity: severityOrEmpty(env, "FAIL_ON_SEVERITY"),
    },
    schedule: {
      storeFile: str(env, "SCHEDULE_STORE_FILE", "./.reviewpilot/schedules.json"),
      feishuWebhookUrl: str(env, "FEISHU_WEBHOOK_URL", ""),
    },
    sessionSecret: str(env, "SESSION_SECRET", ""),
    sessionTtlMs: int(env, "SESSION_TTL_MS", 604800000),
    adminEmail: str(env, "ADMIN_EMAIL", "admin@reviewpilot.local"),
    adminToken: str(env, "ADMIN_TOKEN", ""),
    publicBaseUrl: str(env, "PUBLIC_BASE_URL", "").replace(/\/+$/, ""),
    oidc: {
      issuer: str(env, "OIDC_ISSUER", ""),
      clientId: str(env, "OIDC_CLIENT_ID", ""),
      clientSecret: str(env, "OIDC_CLIENT_SECRET", ""),
      scopes: str(env, "OIDC_SCOPES", "openid profile email"),
      groupsClaim: str(env, "OIDC_GROUPS_CLAIM", "groups"),
      groupRoleMap: parseGroupRoleMap(str(env, "OIDC_GROUP_ROLE_MAP", "")),
      apiUrl: str(env, "AUTHENTIK_API_URL", ""),
      apiToken: str(env, "AUTHENTIK_API_TOKEN", ""),
    },
    webDistDir: str(env, "WEB_DIST_DIR", ""),
    workspaceDir: str(env, "WORKSPACE_DIR", "./.workspace"),
  };
}
