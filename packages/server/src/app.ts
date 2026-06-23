import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createApiHandler } from "./api/rest-api.js";
import { resolvePrincipal } from "./auth/authorize.js";
import { envAdminFrom } from "./auth/env-admin.js";
import { handleMcp } from "./mcp/mcp-server.js";
import type { Repository } from "./persistence/repository.js";
import {
  SKILL_NAME,
  buildInstallScript,
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
  /** Built-in env-configured admin (email + password); password enables it. */
  adminEmail?: string;
  adminPassword?: string;
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
    ...(deps.adminPassword ? { adminPassword: deps.adminPassword } : {}),
    taskService: deps.taskService,
    ...(deps.scheduleStore ? { scheduleStore: deps.scheduleStore } : {}),
    ...(deps.scheduler ? { scheduler: deps.scheduler } : {}),
  });
  const serveStatic = createStaticHandler(resolveWebDistDir(deps.webDistDir ?? ""));
  // MCP endpoint auth: resolve the bearer credential (PAT or session) the same
  // way the REST API does, so every user drives MCP with their own token.
  const secret = deps.sessionSecret ?? "";
  const envAdmin = envAdminFrom(deps.adminEmail ?? "", deps.adminPassword ?? "");
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    // Local Claude Code skill (public artifact — no auth): one-line installer
    // and the raw SKILL.md, generated from the shared review kernel.
    if (path === "/skill/install.sh") {
      res.writeHead(200, { "Content-Type": "text/x-shellscript; charset=utf-8" });
      res.end(buildInstallScript(buildReviewSkill()));
      return;
    }
    if (path === `/skill/${SKILL_NAME}/SKILL.md` || path === "/skill/SKILL.md") {
      res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
      res.end(buildReviewSkill());
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

/** Start the unified HTTP server. */
export function startAppServer(deps: AppDeps, port: number): Server {
  const handler = createAppHandler(deps);
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  server.listen(port);
  return server;
}
