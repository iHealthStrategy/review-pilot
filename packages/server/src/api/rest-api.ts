import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Platform, ReviewEngineKind } from "../domain/entities.js";
import { EntityNotFoundError, type Repository } from "../persistence/repository.js";
import type { TriggerService } from "../trigger/trigger-service.js";

const PLATFORMS: readonly Platform[] = ["github", "gitlab"];
const ENGINES: readonly ReviewEngineKind[] = [
  "mock",
  "cursor",
  "claude-code",
  "claude-agent",
  "codex",
];

interface ApiResult {
  status: number;
  body: unknown;
}

type Handler = (
  ctx: { params: Record<string, string>; body: unknown; query: URLSearchParams },
  repo: Repository,
  trigger: TriggerService | undefined,
) => Promise<ApiResult>;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function ok(body: unknown, status = 200): ApiResult {
  return { status, body };
}

function asString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new HttpError(400, `field '${field}' must be a non-empty string`);
  }
  return v;
}

function asEnum<T extends string>(v: unknown, allowed: readonly T[], field: string): T {
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    throw new HttpError(400, `field '${field}' must be one of ${allowed.join(", ")}`);
  }
  return v as T;
}

const ROUTES: Route[] = [
  {
    method: "GET",
    pattern: /^\/api\/health$/,
    handler: async () => ok({ status: "ok", service: "reviewpilot" }),
  },
  {
    method: "GET",
    pattern: /^\/api\/projects$/,
    handler: async (_ctx, repo) => ok(await repo.listProjects()),
  },
  {
    method: "POST",
    pattern: /^\/api\/projects$/,
    handler: async ({ body }, repo) => {
      const b = (body ?? {}) as Record<string, unknown>;
      const enabled = Array.isArray(b.enabledEngines) ? b.enabledEngines : [];
      const project = await repo.createProject({
        name: asString(b.name, "name"),
        platform: asEnum(b.platform, PLATFORMS, "platform"),
        defaultEngine: asEnum(b.defaultEngine, ENGINES, "defaultEngine"),
        enabledEngines: enabled.map((e, i) => asEnum(e, ENGINES, `enabledEngines[${i}]`)),
      });
      return ok(project, 201);
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/projects\/(?<id>[^/]+)$/,
    handler: async ({ params }, repo) => {
      const project = await repo.getProject(params.id!);
      if (!project) throw new HttpError(404, `project not found: ${params.id}`);
      const repos = await repo.listReposByProject(project.id);
      return ok({ ...project, repos });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/projects\/(?<id>[^/]+)\/repos$/,
    handler: async ({ params }, repo) => {
      if (!(await repo.getProject(params.id!))) {
        throw new HttpError(404, `project not found: ${params.id}`);
      }
      return ok(await repo.listReposByProject(params.id!));
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/projects\/(?<id>[^/]+)\/repos$/,
    handler: async ({ params, body }, repo) => {
      const b = (body ?? {}) as Record<string, unknown>;
      const platform = asEnum(b.platform, PLATFORMS, "platform");
      const fullName = asString(b.fullName, "fullName");
      // Idempotent: a repo is uniquely identified within a project by
      // (platform, fullName). If it's already registered, return the existing
      // record (200) instead of creating a duplicate — guards against
      // double-submits and retries.
      const existing = (await repo.listReposByProject(params.id!)).find(
        (r) => r.platform === platform && r.fullName === fullName,
      );
      if (existing) return ok(existing, 200);
      const created = await repo.createRepo({
        projectId: params.id!,
        platform,
        fullName,
        remoteUrl: asString(b.remoteUrl, "remoteUrl"),
        cloneUrl: asString(b.cloneUrl, "cloneUrl"),
        defaultBranch: asString(b.defaultBranch, "defaultBranch"),
      });
      return ok(created, 201);
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/jobs$/,
    handler: async ({ query }, repo) => {
      const status = query.get("status") ?? undefined;
      const pullRequestId = query.get("pullRequestId") ?? undefined;
      const jobs = await repo.listReviewJobs({
        ...(status ? { status: status as never } : {}),
        ...(pullRequestId ? { pullRequestId } : {}),
      });
      return ok(jobs);
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/jobs\/(?<id>[^/]+)$/,
    handler: async ({ params }, repo) => {
      const job = await repo.getReviewJob(params.id!);
      if (!job) throw new HttpError(404, `job not found: ${params.id}`);
      const pullRequest = await repo.getPullRequest(job.pullRequestId);
      const findings = await repo.listFindings(job.id);
      return ok({ ...job, pullRequest, findings });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/jobs\/(?<id>[^/]+)\/findings$/,
    handler: async ({ params }, repo) => {
      if (!(await repo.getReviewJob(params.id!))) {
        throw new HttpError(404, `job not found: ${params.id}`);
      }
      return ok(await repo.listFindings(params.id!));
    },
  },
  {
    // Requeue a failed job; the background worker drain re-runs it.
    method: "POST",
    pattern: /^\/api\/jobs\/(?<id>[^/]+)\/retry$/,
    handler: async ({ params }, repo) => {
      const job = await repo.getReviewJob(params.id!);
      if (!job) throw new HttpError(404, `job not found: ${params.id}`);
      if (job.status !== "failed") {
        throw new HttpError(409, `only failed jobs can be retried (job is ${job.status})`);
      }
      return ok(await repo.transitionReviewJob(job.id, "pending"));
    },
  },
  {
    // API-based review trigger — alternative to the webhook path for GitHub
    // Actions and other callers that can't receive inbound webhooks.
    // Requires the repo to be monitored (registered under a project).
    method: "POST",
    pattern: /^\/api\/trigger$/,
    handler: async ({ body }, _repo, trigger) => {
      if (!trigger) throw new HttpError(503, "trigger service not available");
      const b = (body ?? {}) as Record<string, unknown>;
      const platform = asEnum(b.platform, PLATFORMS, "platform");
      const repoFullName = asString(b.repoFullName, "repoFullName");
      const prNumber = typeof b.prNumber === "number" ? b.prNumber : Number.parseInt(String(b.prNumber ?? ""), 10);
      if (!Number.isFinite(prNumber) || prNumber <= 0) {
        throw new HttpError(400, "field 'prNumber' must be a positive integer");
      }
      const outcome = await trigger.enqueueByNumber(platform, repoFullName, prNumber);
      if (outcome.status !== "created" && outcome.status !== "deduped") {
        throw new HttpError(404, outcome.reason);
      }
      return ok({ jobId: outcome.jobId, status: outcome.status }, 202);
    },
  },
];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * REST API for the Jenkins-like Web UI. Read paths expose projects, repos,
 * jobs (with progress/logs) and findings; write paths configure projects and
 * repos. Platform credentials remain env-configured (see config layer), not
 * stored per-project, so nothing secret is returned here.
 */
export interface ApiOptions {
  /** When set, every route except /api/health requires `Bearer <token>`. */
  apiToken?: string;
  /** Required for the POST /api/trigger route. */
  triggerService?: TriggerService;
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  return header === `Bearer ${token}`;
}

export function createApiHandler(repo: Repository, options: ApiOptions = {}) {
  const token = options.apiToken ?? "";
  const trigger = options.triggerService;
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? "GET";
    const parsed = new URL(req.url ?? "/", "http://localhost");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    // Bearer auth (health stays open for liveness probes).
    if (token && parsed.pathname !== "/api/health" && !authorized(req, token)) {
      send(401, { error: "unauthorized" });
      return;
    }
    const route = ROUTES.find(
      (r) => r.method === method && r.pattern.test(parsed.pathname),
    );
    if (!route) {
      send(404, { error: `no route for ${method} ${parsed.pathname}` });
      return;
    }
    try {
      const match = route.pattern.exec(parsed.pathname);
      const params = match?.groups ?? {};
      let body: unknown;
      if (method === "POST" || method === "PUT" || method === "PATCH") {
        const raw = await readBody(req);
        body = raw ? JSON.parse(raw) : {};
      }
      const result = await route.handler(
        { params, body, query: parsed.searchParams },
        repo,
        trigger,
      );
      send(result.status, result.body);
    } catch (err) {
      if (err instanceof HttpError) send(err.status, { error: err.message });
      else if (err instanceof EntityNotFoundError) send(404, { error: err.message });
      else if (err instanceof SyntaxError) send(400, { error: "invalid JSON body" });
      else send(500, { error: (err as Error).message });
    }
  };
}

/** Start an HTTP server exposing the REST API. */
export function startApiServer(repo: Repository, port: number): Server {
  const handler = createApiHandler(repo);
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  server.listen(port);
  return server;
}
