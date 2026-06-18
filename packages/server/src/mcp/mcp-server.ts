import type { IncomingMessage, ServerResponse } from "node:http";
import { type Principal, roleAtLeast } from "../auth/authorize.js";
import type { Platform, ReviewEngineKind, UserRole } from "../domain/entities.js";
import type { Repository } from "../persistence/repository.js";
import type { ScheduleStore } from "../schedule/schedule.js";
import type { Scheduler } from "../schedule/scheduler.js";
import type { ReviewTaskInput, TaskService } from "../trigger/trigger-service.js";

/**
 * Minimal Model Context Protocol (MCP) server over Streamable HTTP, hand-rolled
 * on JSON-RPC 2.0 so it adds no dependency. A single `POST /mcp` endpoint speaks
 * `initialize` / `tools/list` / `tools/call` / `ping`. Auth reuses the platform's
 * bearer credential (a personal access token, `Authorization: Bearer rpat_…`, or
 * a session token) — the caller is resolved to a {@link Principal} BEFORE this
 * handler runs, and tools are gated by the same RBAC roles as the REST API.
 */
export interface McpDeps {
  repo: Repository;
  taskService?: TaskService;
  scheduleStore?: ScheduleStore;
  scheduler?: Scheduler;
}

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "reviewpilot", version: "0.1.0" };
const PLATFORMS: readonly Platform[] = ["github", "gitlab"];

/** A tool failure surfaced to the model as `isError` content (not a protocol error). */
class ToolError extends Error {}

interface Tool {
  name: string;
  description: string;
  minRole: UserRole;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>, deps: McpDeps, principal: Principal): Promise<string>;
}

function need<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new ToolError(`${what} is not available on this server`);
  return v;
}
function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v) throw new ToolError(`'${key}' must be a non-empty string`);
  return v;
}

const TOOLS: Tool[] = [
  {
    name: "whoami",
    description: "Return the authenticated user's id and role.",
    minRole: "viewer",
    inputSchema: { type: "object", properties: {} },
    run: async (_a, _d, p) => JSON.stringify({ userId: p.userId, role: p.role, via: p.via }),
  },
  {
    name: "list_schedules",
    description: "List the configured scheduled scans and their last result.",
    minRole: "viewer",
    inputSchema: { type: "object", properties: {} },
    run: async (_a, d) => {
      const store = need(d.scheduleStore, "scheduling");
      const list = await store.list();
      return JSON.stringify(
        list.map((s) => ({
          id: s.id,
          name: s.name,
          repoFullName: s.repoFullName,
          enabled: s.enabled,
          running: s.running ?? false,
          timeOfDay: s.timeOfDay,
          timezone: s.timezone,
          lastResult: s.lastResult ?? null,
        })),
        null,
        2,
      );
    },
  },
  {
    name: "list_jobs",
    description: "List recent review jobs (most recent first).",
    minRole: "viewer",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["pending", "running", "succeeded", "failed"] },
        limit: { type: "number", description: "Max jobs to return (default 20)." },
      },
    },
    run: async (args, d) => {
      const filter = typeof args.status === "string" ? { status: args.status as never } : {};
      const limit = typeof args.limit === "number" && args.limit > 0 ? args.limit : 20;
      const jobs = (await d.repo.listReviewJobs(filter))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, limit);
      return JSON.stringify(
        jobs.map((j) => ({
          id: j.id,
          engine: j.engine,
          status: j.status,
          progress: j.progress,
          createdAt: j.createdAt,
          error: j.error ?? null,
        })),
        null,
        2,
      );
    },
  },
  {
    name: "get_job",
    description: "Get a review job with its findings.",
    minRole: "viewer",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string" } },
      required: ["jobId"],
    },
    run: async (args, d) => {
      const id = str(args, "jobId");
      const job = await d.repo.getReviewJob(id);
      if (!job) throw new ToolError(`job not found: ${id}`);
      const findings = await d.repo.listFindings(id);
      return JSON.stringify({ ...job, findings }, null, 2);
    },
  },
  {
    name: "create_review_task",
    description:
      "Queue a self-contained review. PR mode: pass prNumber. Branch mode: pass headBranch + baseBranch. Returns the job/task id.",
    minRole: "member",
    inputSchema: {
      type: "object",
      properties: {
        platform: { type: "string", enum: ["github", "gitlab"] },
        repoFullName: { type: "string", description: "owner/repo" },
        prNumber: { type: "number" },
        headBranch: { type: "string" },
        baseBranch: { type: "string" },
        cloneUrl: { type: "string" },
        engine: { type: "string", enum: ["mock", "cursor", "claude-code", "claude-agent", "codex"] },
      },
      required: ["platform", "repoFullName"],
    },
    run: async (args, d) => {
      const tasks = need(d.taskService, "task ingress");
      const platform = str(args, "platform");
      if (!PLATFORMS.includes(platform as Platform)) {
        throw new ToolError(`'platform' must be one of ${PLATFORMS.join(", ")}`);
      }
      const input: ReviewTaskInput = {
        platform: platform as Platform,
        repoFullName: str(args, "repoFullName"),
      };
      if (typeof args.prNumber === "number") input.prNumber = args.prNumber;
      if (typeof args.headBranch === "string") input.headBranch = args.headBranch;
      if (typeof args.baseBranch === "string") input.baseBranch = args.baseBranch;
      if (typeof args.cloneUrl === "string") input.cloneUrl = args.cloneUrl;
      if (typeof args.engine === "string") input.engine = args.engine as ReviewEngineKind;
      const outcome = await tasks.createTask(input);
      if (outcome.status === "ignored") throw new ToolError(outcome.reason);
      return JSON.stringify(outcome, null, 2);
    },
  },
  {
    name: "run_schedule",
    description: "Trigger a scheduled scan now (runs in the background; check list_schedules for the result).",
    minRole: "member",
    inputSchema: {
      type: "object",
      properties: { scheduleId: { type: "string" } },
      required: ["scheduleId"],
    },
    run: async (args, d) => {
      const store = need(d.scheduleStore, "scheduling");
      const scheduler = need(d.scheduler, "scheduling");
      const id = str(args, "scheduleId");
      const config = await store.get(id);
      if (!config) throw new ToolError(`schedule not found: ${id}`);
      if (scheduler.isRunning(config.id) || config.running) {
        throw new ToolError("schedule is already running");
      }
      // Fire-and-forget: a scan can take many minutes, too long to hold the call.
      void scheduler.runConfig(config).catch(() => {});
      return `Scan started for "${config.name}". Poll list_schedules for the result.`;
    },
  },
];

// --- JSON-RPC plumbing ---

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

function result(id: JsonRpcMessage["id"], value: unknown) {
  return { jsonrpc: "2.0", id, result: value };
}
function rpcError(id: JsonRpcMessage["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
function textContent(text: string, isError = false) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

async function dispatch(
  msg: JsonRpcMessage,
  deps: McpDeps,
  principal: Principal,
): Promise<object | null> {
  const { id, method } = msg;
  switch (method) {
    case "initialize":
      return result(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return null; // notifications get no response
    case "ping":
      return result(id, {});
    case "tools/list": {
      const tools = TOOLS.filter((t) => roleAtLeast(principal.role, t.minRole)).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      return result(id, { tools });
    }
    case "tools/call": {
      const params = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return result(id, textContent(`unknown tool: ${params.name}`, true));
      if (!roleAtLeast(principal.role, tool.minRole)) {
        return result(id, textContent(`forbidden: '${tool.name}' requires role '${tool.minRole}'`, true));
      }
      try {
        const text = await tool.run(params.arguments ?? {}, deps, principal);
        return result(id, textContent(text));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return result(id, textContent(message, true));
      }
    }
    default:
      if (id === undefined) return null; // unknown notification
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/**
 * Handle a `POST /mcp` request. The caller MUST already be authenticated
 * (principal resolved from the bearer token) — auth/RBAC are enforced here only
 * at the per-tool level.
 */
export async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpDeps,
  principal: Principal,
): Promise<void> {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  let parsed: unknown;
  try {
    const raw = await readBody(req);
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    send(400, rpcError(null, -32700, "parse error"));
    return;
  }

  // JSON-RPC batch or single message.
  if (Array.isArray(parsed)) {
    const responses = (
      await Promise.all(parsed.map((m) => dispatch(m as JsonRpcMessage, deps, principal)))
    ).filter((r): r is object => r !== null);
    send(responses.length ? 200 : 202, responses.length ? responses : "");
    return;
  }
  const response = await dispatch(parsed as JsonRpcMessage, deps, principal);
  if (response === null) {
    res.writeHead(202).end(); // notification → no body
    return;
  }
  send(200, response);
}
