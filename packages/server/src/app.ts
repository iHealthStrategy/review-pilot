import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createApiHandler } from "./api/rest-api.js";
import type { Repository } from "./persistence/repository.js";
import type { TriggerService } from "./trigger/trigger-service.js";
import { createWebhookHandler } from "./trigger/webhook-server.js";
import { createStaticHandler, resolveWebDistDir } from "./web/static-server.js";

export interface AppDeps {
  repo: Repository;
  triggerService: TriggerService;
  /** Bearer token guarding the /api surface; empty/omitted disables auth. */
  apiToken?: string;
  /** Override directory for the built Web UI (defaults to bundled location). */
  webDistDir?: string;
}

/**
 * Single HTTP entry point dispatching by path prefix:
 *   /webhook/{github,gitlab}  → PR trigger ingest (HMAC-authenticated)
 *   /api/...                  → REST API for the Web UI (bearer-authenticated)
 *   /*                        → the static Web UI dashboard (SPA)
 * Composes the already-tested per-area handlers; this is the deployable face.
 */
export function createAppHandler(deps: AppDeps) {
  const webhook = createWebhookHandler(deps.triggerService);
  const api = createApiHandler(deps.repo, {
    apiToken: deps.apiToken,
    triggerService: deps.triggerService,
  });
  const serveStatic = createStaticHandler(resolveWebDistDir(deps.webDistDir ?? ""));
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (path.startsWith("/webhook")) return webhook(req, res);
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
