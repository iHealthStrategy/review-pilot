import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Platform } from "../domain/entities.js";
import type { TriggerService } from "./trigger-service.js";

const PLATFORM_ROUTES: Record<string, Platform> = {
  "/webhook/github": "github",
  "/webhook/gitlab": "gitlab",
};

function lowerHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") out[k.toLowerCase()] = v;
    else if (Array.isArray(v)) out[k.toLowerCase()] = v.join(", ");
  }
  return out;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Build the `/webhook/{github,gitlab}` HTTP request listener. Reads the raw
 * body (required for signature verification), delegates to
 * {@link TriggerService.handleWebhook}, and maps the outcome to an HTTP status.
 */
export function createWebhookHandler(service: TriggerService) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = req.url ?? "";
    const platform = PLATFORM_ROUTES[url.split("?")[0] ?? ""];
    if (req.method !== "POST" || !platform) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    try {
      const rawBody = await readBody(req);
      const outcome = await service.handleWebhook(platform, {
        headers: lowerHeaders(req),
        rawBody,
      });
      const status = outcome.status === "rejected" ? 401 : 202;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(outcome));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  };
}

/** Start an HTTP server exposing the webhook endpoint. */
export function startWebhookServer(
  service: TriggerService,
  port: number,
): Server {
  const handler = createWebhookHandler(service);
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  server.listen(port);
  return server;
}
