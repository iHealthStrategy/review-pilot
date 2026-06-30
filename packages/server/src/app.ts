import { createHmac, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createApiHandler } from "./api/rest-api.js";
import { resolvePrincipal } from "./auth/authorize.js";
import { envAdminFrom } from "./auth/env-admin.js";
import {
  type OidcConfig,
  OidcClient,
  oidcEnabled,
  pkceChallenge,
  randomUrlToken,
} from "./auth/oidc.js";
import { provisionUser } from "./auth/provision.js";
import { signSession } from "./auth/session.js";
import { handleMcp } from "./mcp/mcp-server.js";
import type { Repository } from "./persistence/repository.js";
import {
  SKILL_NAME,
  buildInstallScript,
  buildOrchestratorSkill,
  buildReviewSkill,
  rulesetSkillName,
} from "./skill/review-skill.js";
import type { ScheduleStore } from "./schedule/schedule.js";
import type { Scheduler } from "./schedule/scheduler.js";
import type { TaskService } from "./trigger/trigger-service.js";
import { createStaticHandler, resolveWebDistDir } from "./web/static-server.js";

export interface AppDeps {
  repo: Repository;
  taskService: TaskService;
  /** Session-token signing secret guarding the /api surface; empty disables auth. */
  sessionSecret?: string;
  /** Session token lifetime (ms). */
  sessionTtlMs?: number;
  /** Built-in env-configured admin email (display only). */
  adminEmail?: string;
  /** Config-only PAT for the env admin (bearer auth without a DB row); enables it. */
  adminToken?: string;
  /** Public base URL (scheme://host) for OIDC redirect URI + self links. */
  publicBaseUrl?: string;
  /** OIDC provider config; when set, interactive login is delegated to it. */
  oidc?: OidcConfig;
  /** Override directory for the built Web UI (defaults to bundled location). */
  webDistDir?: string;
  /** Backs the /api/schedules routes (scheduled scans). */
  scheduleStore?: ScheduleStore;
  /** Refreshed on schedule changes; runs schedules on demand. */
  scheduler?: Scheduler;
}

/**
 * Single HTTP entry point dispatching by path prefix:
 *   /api/...  → REST API (review tasks + jobs), bearer-authenticated
 *   /*        → the static Web UI dashboard (SPA)
 * Composes the already-tested per-area handlers; this is the deployable face.
 */
export function createAppHandler(deps: AppDeps) {
  const api = createApiHandler(deps.repo, {
    ...(deps.sessionSecret ? { sessionSecret: deps.sessionSecret } : {}),
    ...(deps.sessionTtlMs !== undefined ? { sessionTtlMs: deps.sessionTtlMs } : {}),
    ...(deps.adminEmail !== undefined ? { adminEmail: deps.adminEmail } : {}),
    ...(deps.adminToken ? { adminToken: deps.adminToken } : {}),
    taskService: deps.taskService,
    ...(deps.scheduleStore ? { scheduleStore: deps.scheduleStore } : {}),
    ...(deps.scheduler ? { scheduler: deps.scheduler } : {}),
  });
  const serveStatic = createStaticHandler(resolveWebDistDir(deps.webDistDir ?? ""));
  // MCP endpoint auth: resolve the bearer credential (PAT or session) the same
  // way the REST API does, so every user drives MCP with their own token.
  const secret = deps.sessionSecret ?? "";
  const envAdmin = envAdminFrom(deps.adminEmail ?? "", deps.adminToken ?? "");
  const sessionTtlMs = deps.sessionTtlMs ?? 7 * 24 * 60 * 60 * 1000;
  // OIDC login is delegated to the provider; minting our own session after the
  // handshake requires a signing secret, so fail closed if it's missing.
  if (oidcEnabled(deps.oidc) && !secret) {
    throw new Error("OIDC is configured but SESSION_SECRET is empty; refusing to start (set SESSION_SECRET)");
  }
  const oidc = oidcEnabled(deps.oidc) ? new OidcClient(deps.oidc) : null;
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    // The server's own origin, for self-referential links (skill callbacks, the
    // OIDC redirect URI). Prefer the configured PUBLIC_BASE_URL over request
    // headers so a spoofed Host can't redirect or poison generated artifacts.
    const baseUrl = deps.publicBaseUrl || requestOrigin(req);

    // --- OIDC login flow (delegated authentication) ---
    if (path === "/api/auth/oidc/login" || path === "/api/auth/oidc/callback" || path === "/api/auth/oidc/logout") {
      if (!oidc) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "OIDC is not configured on this server" }));
        return;
      }
      const redirectUri = `${baseUrl}/api/auth/oidc/callback`;
      try {
        if (path === "/api/auth/oidc/login") {
          const state = randomUrlToken();
          const nonce = randomUrlToken();
          const codeVerifier = randomUrlToken();
          const cookie = encodeCookie({ state, nonce, codeVerifier }, secret);
          const url = await oidc.authorizeUrl({
            redirectUri,
            state,
            nonce,
            codeChallenge: pkceChallenge(codeVerifier),
          });
          res.writeHead(302, {
            Location: url,
            "Set-Cookie": `rp_oidc=${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`,
          });
          res.end();
          return;
        }
        if (path === "/api/auth/oidc/logout") {
          const end = await oidc.endSessionUrl(baseUrl || "/");
          res.writeHead(302, { Location: end ?? (baseUrl || "/") });
          res.end();
          return;
        }
        // callback: validate state, exchange the code, provision, mint a session.
        const url = new URL(req.url ?? "/", "http://localhost");
        const code = url.searchParams.get("code") ?? "";
        const state = url.searchParams.get("state") ?? "";
        const saved = decodeCookie(getCookie(req, "rp_oidc"), secret);
        const clearCookie = "rp_oidc=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
        if (!code || !saved || saved.state !== state) {
          res.writeHead(302, {
            Location: `${baseUrl || ""}/#oidc_error=${encodeURIComponent("invalid login state")}`,
            "Set-Cookie": clearCookie,
          });
          res.end();
          return;
        }
        const identity = await oidc.exchangeCode({
          code,
          redirectUri,
          codeVerifier: saved.codeVerifier,
          nonce: saved.nonce,
        });
        const user = await provisionUser(deps.repo, identity, oidc.roleForGroups(identity.groups));
        const token = signSession({ sub: user.id, role: user.role }, secret, sessionTtlMs);
        // Deliver the session token to the SPA via the URL fragment (kept out of
        // server logs / Referer); the app stores it and uses Authorization: Bearer.
        res.writeHead(302, {
          Location: `${baseUrl || ""}/#rp_session=${encodeURIComponent(token)}`,
          "Set-Cookie": clearCookie,
        });
        res.end();
        return;
      } catch (err) {
        res.writeHead(302, {
          Location: `${baseUrl || ""}/#oidc_error=${encodeURIComponent((err as Error).message)}`,
          "Set-Cookie": "rp_oidc=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
        });
        res.end();
        return;
      }
    }
    // Local Claude Code skill (public artifact — no auth): one-line installer and
    // the raw SKILL.md. The default skill is the orchestrator. If the caller
    // presents their OWN bearer token (PAT/session), it is baked into the skill so
    // the download is pre-configured (no manual REVIEWPILOT_TOKEN setup); the token
    // is only ever reflected back to the caller that supplied it.
    const installToken = bearerToken(req);
    if (path === "/skill/install.sh") {
      res.writeHead(200, { "Content-Type": "text/x-shellscript; charset=utf-8" });
      res.end(buildInstallScript(buildOrchestratorSkill(baseUrl, installToken)));
      return;
    }
    if (path === `/skill/${SKILL_NAME}/SKILL.md` || path === "/skill/SKILL.md") {
      res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
      res.end(buildOrchestratorSkill(baseUrl, installToken));
      return;
    }
    // Per-ruleset skill: public → open; private → requires the owner's token.
    const rulesetSkill = /^\/skill\/ruleset\/([^/]+)\/(install\.sh|SKILL\.md)$/.exec(path);
    if (rulesetSkill) {
      const [, id, kind] = rulesetSkill;
      const ruleset = await deps.repo.getRuleset(id!);
      if (!ruleset) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "ruleset not found" }));
        return;
      }
      if (ruleset.visibility !== "public") {
        const principal = await resolvePrincipal(req.headers.authorization, deps.repo, secret, envAdmin);
        const allowed = principal && (principal.userId === ruleset.ownerId || principal.role === "admin");
        if (!allowed) {
          res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
          res.end(JSON.stringify({ error: "unauthorized: private ruleset requires the owner's token" }));
          return;
        }
      }
      const md = buildReviewSkill(ruleset);
      if (kind === "install.sh") {
        res.writeHead(200, { "Content-Type": "text/x-shellscript; charset=utf-8" });
        res.end(buildInstallScript(md, rulesetSkillName(ruleset.slug)));
      } else {
        res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
        res.end(md);
      }
      return;
    }
    if (path === "/mcp") {
      if ((req.method ?? "GET") !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
        res.end(JSON.stringify({ error: "use POST for the MCP endpoint" }));
        return;
      }
      const principal = await resolvePrincipal(req.headers.authorization, deps.repo, secret, envAdmin);
      if (!principal) {
        res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
        res.end(JSON.stringify({ error: "unauthorized: provide a personal access token" }));
        return;
      }
      return handleMcp(req, res, {
        repo: deps.repo,
        taskService: deps.taskService,
        ...(deps.scheduleStore ? { scheduleStore: deps.scheduleStore } : {}),
        ...(deps.scheduler ? { scheduler: deps.scheduler } : {}),
      }, principal);
    }
    if (path.startsWith("/api")) return api(req, res);
    return serveStatic(path, res);
  };
}

/**
 * The origin (scheme://host) the request reached us on, so artifacts we generate
 * can call back to this server. Honours X-Forwarded-Proto/Host set by a reverse
 * proxy; falls back to the Host header. Empty when neither is present (the skill
 * then falls back to its REVIEWPILOT_URL env var).
 */
/** Extract a `Bearer <token>` credential from the request, or "" when absent. */
function bearerToken(req: IncomingMessage): string {
  const h = req.headers.authorization;
  const m = /^Bearer\s+(.+)$/i.exec((h ?? "").trim());
  return m ? m[1]!.trim() : "";
}

/** Transient OIDC handshake state carried across the redirect in a signed cookie. */
interface OidcCookie {
  state: string;
  nonce: string;
  codeVerifier: string;
}

/** Encode + HMAC-sign the handshake cookie so the client can't tamper with it. */
function encodeCookie(data: OidcCookie, secret: string): string {
  const value = Buffer.from(JSON.stringify(data)).toString("base64url");
  const sig = createHmac("sha256", secret).update(value).digest("base64url");
  return `${value}.${sig}`;
}

/** Verify + decode the handshake cookie; null when missing/tampered. */
function decodeCookie(raw: string, secret: string): OidcCookie | null {
  if (!raw) return null;
  const i = raw.lastIndexOf(".");
  if (i < 0) return null;
  const value = raw.slice(0, i);
  const sig = Buffer.from(raw.slice(i + 1));
  const expected = createHmac("sha256", secret).update(value).digest("base64url");
  const exp = Buffer.from(expected);
  if (sig.length !== exp.length || !timingSafeEqual(sig, exp)) return null;
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as OidcCookie;
  } catch {
    return null;
  }
}

/** Read a named cookie from the request, or "" when absent. */
function getCookie(req: IncomingMessage, name: string): string {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return "";
}

function requestOrigin(req: IncomingMessage): string {
  const header = (name: string): string => {
    const v = req.headers[name];
    return (Array.isArray(v) ? v[0] : v)?.split(",")[0]?.trim() ?? "";
  };
  const host = header("x-forwarded-host") || header("host");
  if (!host) return "";
  const proto = header("x-forwarded-proto") || "http";
  return `${proto}://${host}`;
}

/** Start the unified HTTP server. */
export function startAppServer(deps: AppDeps, port: number): Server {
  const handler = createAppHandler(deps);
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  server.listen(port);
  return server;
}
