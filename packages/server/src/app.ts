import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createApiHandler } from "./api/rest-api.js";
import type { Repository } from "./persistence/repository.js";
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
    taskService: deps.taskService,
    ...(deps.scheduleStore ? { scheduleStore: deps.scheduleStore } : {}),
    ...(deps.scheduler ? { scheduler: deps.scheduler } : {}),
  });
  const serveStatic = createStaticHandler(resolveWebDistDir(deps.webDistDir ?? ""));
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
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
