import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/**
 * Resolve the directory of the built Web UI. Uses the explicit override when
 * given, otherwise the `packages/web/dist` co-located with this compiled
 * server (works in the Docker image and local `dist` layout alike).
 */
export function resolveWebDistDir(override: string): string {
  if (override) return resolve(override);
  // this file compiles to packages/server/dist/src/web/static-server.js
  return fileURLToPath(new URL("../../../../web/dist", import.meta.url));
}

/**
 * Minimal static file server for the single-page Web UI. Guards against path
 * traversal, serves `index.html` for `/` and for any unknown non-asset path
 * (SPA fallback), and 404s on missing assets.
 */
export function createStaticHandler(distDir: string) {
  const root = resolve(distDir);
  return async (pathname: string, res: ServerResponse): Promise<void> => {
    const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const target = normalize(join(root, rel));
    // Containment check: resolved path must stay within the dist root.
    const inRoot = target === root || target.startsWith(root + sep);
    const file = inRoot && extname(target) ? target : join(root, "index.html");
    try {
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
  };
}
