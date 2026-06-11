import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Platform, ReviewEngineKind } from "../domain/entities.js";
import { EntityNotFoundError, type Repository } from "../persistence/repository.js";
import type { ReviewTaskInput, TaskService } from "../trigger/trigger-service.js";
import type {
  CreateScheduleInput,
  DeliveryConfig,
  ScheduleStore,
  UpdateScheduleInput,
} from "../schedule/schedule.js";
import { ScheduleNotFoundError } from "../schedule/schedule.js";
import type { Scheduler } from "../schedule/scheduler.js";
import { parseTimeOfDay } from "../schedule/tz.js";

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
  tasks: TaskService | undefined,
  schedules: ScheduleStore | undefined,
  scheduler: Scheduler | undefined,
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

/** Validate a callback spec: { url, headers? }. */
function parseCallback(v: unknown): { url: string; headers?: Record<string, string> } {
  const c = (v ?? {}) as Record<string, unknown>;
  const url = asString(c.url, "callback.url");
  const headers: Record<string, string> = {};
  if (c.headers && typeof c.headers === "object") {
    for (const [k, val] of Object.entries(c.headers as Record<string, unknown>)) {
      if (typeof val === "string") headers[k] = val;
    }
  }
  return Object.keys(headers).length ? { url, headers } : { url };
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
    // Self-contained review task — the single ingress for reviews. Callers
    // (GitHub Actions, other services, the Web UI form) POST everything needed;
    // no monitored project/repo has to be pre-registered.
    method: "POST",
    pattern: /^\/api\/tasks$/,
    handler: async ({ body }, _repo, tasks) => {
      if (!tasks) throw new HttpError(503, "task service not available");
      const b = (body ?? {}) as Record<string, unknown>;
      const platform = asEnum(b.platform, PLATFORMS, "platform");
      const repoFullName = asString(b.repoFullName, "repoFullName");

      // PR mode (prNumber) vs branch-diff mode (headBranch + baseBranch).
      const hasPr = b.prNumber !== undefined && b.prNumber !== null && b.prNumber !== "";
      const task: ReviewTaskInput = { platform, repoFullName };
      if (hasPr) {
        const prNumber =
          typeof b.prNumber === "number" ? b.prNumber : Number.parseInt(String(b.prNumber), 10);
        if (!Number.isFinite(prNumber) || prNumber <= 0) {
          throw new HttpError(400, "field 'prNumber' must be a positive integer");
        }
        task.prNumber = prNumber;
      } else if (b.headBranch || b.baseBranch) {
        task.headBranch = asString(b.headBranch, "headBranch");
        task.baseBranch = asString(b.baseBranch, "baseBranch");
        if (b.callback) task.callback = parseCallback(b.callback);
      } else {
        throw new HttpError(400, "provide 'prNumber' (PR mode) or 'headBranch'+'baseBranch' (branch mode)");
      }
      if (typeof b.cloneUrl === "string" && b.cloneUrl) task.cloneUrl = b.cloneUrl;
      if (b.engine) task.engine = asEnum(b.engine, ENGINES, "engine");

      const outcome = await tasks.createTask(task);
      if (outcome.status === "ignored") throw new HttpError(400, outcome.reason);
      if (outcome.status === "accepted") {
        return ok({ taskId: outcome.taskId, status: outcome.status }, 202);
      }
      return ok({ taskId: outcome.jobId, jobId: outcome.jobId, status: outcome.status }, 202);
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/schedules$/,
    handler: async (_ctx, _repo, _tasks, schedules) => {
      if (!schedules) throw new HttpError(503, "schedule store not available");
      return ok(await schedules.list());
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/schedules$/,
    handler: async ({ body }, _repo, _tasks, schedules, scheduler) => {
      if (!schedules) throw new HttpError(503, "schedule store not available");
      const created = await schedules.create(parseScheduleCreate(body));
      await scheduler?.refresh();
      return ok(created, 201);
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/schedules\/(?<id>[^/]+)$/,
    handler: async ({ params }, _repo, _tasks, schedules) => {
      if (!schedules) throw new HttpError(503, "schedule store not available");
      const s = await schedules.get(params.id!);
      if (!s) throw new HttpError(404, `schedule not found: ${params.id}`);
      return ok(s);
    },
  },
  {
    method: "PUT",
    pattern: /^\/api\/schedules\/(?<id>[^/]+)$/,
    handler: async ({ params, body }, _repo, _tasks, schedules, scheduler) => {
      if (!schedules) throw new HttpError(503, "schedule store not available");
      const updated = await schedules.update(params.id!, parseScheduleUpdate(body));
      await scheduler?.refresh();
      return ok(updated);
    },
  },
  {
    method: "DELETE",
    pattern: /^\/api\/schedules\/(?<id>[^/]+)$/,
    handler: async ({ params }, _repo, _tasks, schedules, scheduler) => {
      if (!schedules) throw new HttpError(503, "schedule store not available");
      await schedules.remove(params.id!);
      await scheduler?.refresh();
      return { status: 204, body: null };
    },
  },
  {
    // Run a schedule immediately (testing / on-demand), regardless of its time.
    method: "POST",
    pattern: /^\/api\/schedules\/(?<id>[^/]+)\/run$/,
    handler: async ({ params }, _repo, _tasks, schedules, scheduler) => {
      if (!schedules || !scheduler) throw new HttpError(503, "scheduler not available");
      const config = await schedules.get(params.id!);
      if (!config) throw new HttpError(404, `schedule not found: ${params.id}`);
      if (scheduler.isRunning(config.id) || config.running) {
        throw new HttpError(409, "schedule is already running");
      }
      const result = await scheduler.runConfig(config);
      return ok({ ran: result !== null, result });
    },
  },
];

/**
 * Validate a Feishu delivery spec: { type:"feishu", webhookUrl? }. webhookUrl
 * is optional — when omitted, delivery falls back to the deploy-wide
 * FEISHU_WEBHOOK_URL default at send time.
 */
function parseDelivery(v: unknown): DeliveryConfig {
  const d = (v ?? {}) as Record<string, unknown>;
  const type = asEnum(d.type, ["feishu"] as const, "delivery.type");
  const webhookUrl = typeof d.webhookUrl === "string" ? d.webhookUrl : "";
  return { type, webhookUrl };
}

function asBranches(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new HttpError(400, "field 'branches' must be an array of strings");
  return v.map((b, i) => asString(b, `branches[${i}]`));
}

function assertTime(v: string): string {
  if (parseTimeOfDay(v) === null) {
    throw new HttpError(400, "field 'timeOfDay' must be 'HH:MM' (24h)");
  }
  return v;
}

function asLookbackHours(v: unknown): number {
  const n = typeof v === "number" ? v : Number.parseInt(String(v), 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new HttpError(400, "field 'lookbackHours' must be a positive number");
  }
  return n;
}

function parseScheduleCreate(body: unknown): CreateScheduleInput {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    name: asString(b.name, "name"),
    platform: asEnum(b.platform, PLATFORMS, "platform"),
    repoFullName: asString(b.repoFullName, "repoFullName"),
    ...(typeof b.cloneUrl === "string" && b.cloneUrl ? { cloneUrl: b.cloneUrl } : {}),
    branches: asBranches(b.branches),
    timeOfDay: assertTime(asString(b.timeOfDay, "timeOfDay")),
    ...(typeof b.timezone === "string" && b.timezone ? { timezone: b.timezone } : {}),
    ...(b.lookbackHours !== undefined ? { lookbackHours: asLookbackHours(b.lookbackHours) } : {}),
    ...(typeof b.reviewFocus === "string" && b.reviewFocus ? { reviewFocus: b.reviewFocus } : {}),
    ...(b.engine ? { engine: asEnum(b.engine, ENGINES, "engine") } : {}),
    delivery: parseDelivery(b.delivery),
    ...(typeof b.enabled === "boolean" ? { enabled: b.enabled } : {}),
  };
}

function parseScheduleUpdate(body: unknown): UpdateScheduleInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const patch: UpdateScheduleInput = {};
  if (b.name !== undefined) patch.name = asString(b.name, "name");
  if (b.repoFullName !== undefined) patch.repoFullName = asString(b.repoFullName, "repoFullName");
  if (b.cloneUrl !== undefined) patch.cloneUrl = asString(b.cloneUrl, "cloneUrl");
  if (b.branches !== undefined) patch.branches = asBranches(b.branches);
  if (b.timeOfDay !== undefined) patch.timeOfDay = assertTime(asString(b.timeOfDay, "timeOfDay"));
  if (b.timezone !== undefined) patch.timezone = asString(b.timezone, "timezone");
  if (b.lookbackHours !== undefined) patch.lookbackHours = asLookbackHours(b.lookbackHours);
  if (b.reviewFocus !== undefined) {
    if (typeof b.reviewFocus !== "string") throw new HttpError(400, "field 'reviewFocus' must be a string");
    patch.reviewFocus = b.reviewFocus; // "" clears the focus
  }
  if (b.engine !== undefined) patch.engine = b.engine === null ? null : asEnum(b.engine, ENGINES, "engine");
  if (b.delivery !== undefined) patch.delivery = parseDelivery(b.delivery);
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean") throw new HttpError(400, "field 'enabled' must be a boolean");
    patch.enabled = b.enabled;
  }
  return patch;
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
 * REST API for the Jenkins-like Web UI. Read paths expose projects, repos,
 * jobs (with progress/logs) and findings; write paths configure projects and
 * repos. Platform credentials remain env-configured (see config layer), not
 * stored per-project, so nothing secret is returned here.
 */
export interface ApiOptions {
  /** When set, every route except /api/health requires `Bearer <token>`. */
  apiToken?: string;
  /** Required for the POST /api/tasks route. */
  taskService?: TaskService;
  /** Required for the /api/schedules routes. */
  scheduleStore?: ScheduleStore;
  /** Refreshed after schedule mutations; drives manual run-now. */
  scheduler?: Scheduler;
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  return header === `Bearer ${token}`;
}

export function createApiHandler(repo: Repository, options: ApiOptions = {}) {
  const token = options.apiToken ?? "";
  const tasks = options.taskService;
  const schedules = options.scheduleStore;
  const scheduler = options.scheduler;
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
        tasks,
        schedules,
        scheduler,
      );
      send(result.status, result.body);
    } catch (err) {
      if (err instanceof HttpError) send(err.status, { error: err.message });
      else if (err instanceof EntityNotFoundError) send(404, { error: err.message });
      else if (err instanceof ScheduleNotFoundError) send(404, { error: err.message });
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
