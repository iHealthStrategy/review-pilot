import { startAppServer } from "./app.js";
import { type AppConfig, loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import type { Platform, ReviewEngineKind, Severity } from "./domain/entities.js";
import { createRepository } from "./persistence/factory.js";
import type { Repository } from "./persistence/repository.js";
import { createGitProvider } from "./providers/factory.js";
import type { GitProvider } from "./providers/git-provider.js";
import { BranchReviewService } from "./review/branch-review.js";
import { type Cloner, GitCloner } from "./review/cloner.js";
import { ProcessCommandRunner } from "./review/command-runner.js";
import { createReviewEngine } from "./review/engine-factory.js";
import { ReviewService } from "./review/review-service.js";
import { GraphCacheService } from "./review/graph-cache.js";
import { ScheduledScanService } from "./schedule/scan-service.js";
import { createScheduleStore } from "./schedule/schedule-store-factory.js";
import { Scheduler } from "./schedule/scheduler.js";
import { TaskService } from "./trigger/trigger-service.js";
import { Worker } from "./worker/worker.js";
import { NAME, VERSION } from "./version.js";

/** Seams for tests to inject fakes and a fast drain; production uses defaults. */
export interface StartAppOverrides {
  providerFor?: (platform: Platform) => GitProvider;
  cloner?: Cloner;
  /** Period of the background worker drain (ms). */
  drainIntervalMs?: number;
}

export interface RunningApp {
  repo: Repository;
  worker: Worker;
  taskService: TaskService;
  /** Resolves once storage is initialised (indexes/migrations) and any
   * interrupted jobs have been recovered. The background drain/poller wait on
   * this. Await it before treating the service as ready. */
  ready: Promise<void>;
  close: () => Promise<void>;
}

/**
 * Load + validate config and report readiness. Kept as a pure function so it is
 * trivially testable; {@link startApp} performs the actual wiring.
 */
export function bootstrap(env: NodeJS.ProcessEnv = process.env): {
  name: string;
  version: string;
  port: number;
} {
  const config = loadConfig(env);
  return { name: NAME, version: VERSION, port: config.port };
}

/**
 * Assemble the full service from {@link AppConfig}: repository (driver per
 * config), per-platform providers, trigger, review pipeline and worker; expose
 * the unified HTTP server and, when enabled, the polling fallback plus a
 * periodic worker drain. Defaults run credential-free in mock mode.
 */
export function startApp(
  config: AppConfig,
  overrides: StartAppOverrides = {},
): RunningApp {
  const repo = createRepository(config);
  const providerCache = new Map<Platform, GitProvider>();
  const providerFor =
    overrides.providerFor ??
    ((platform: Platform): GitProvider => {
      let p = providerCache.get(platform);
      if (!p) {
        p = createGitProvider(platform, config);
        providerCache.set(platform, p);
      }
      return p;
    });

  // Build an engine for a kind with the same config-driven knobs as the PR
  // pipeline — shared by the branch-diff and scheduled-scan reviewers.
  const { engineCommand, engineArgs, agentModel, agentMaxTurns } = config.review;
  const createEngine = (kind: ReviewEngineKind) =>
    createReviewEngine(kind, {
      timeoutMs: config.worker.engineTimeoutMs,
      ...(engineCommand ? { commands: { [kind]: engineCommand } } : {}),
      ...(engineArgs.length ? { args: { [kind]: engineArgs } } : {}),
      agent: {
        ...(agentModel ? { model: agentModel } : {}),
        maxTurns: agentMaxTurns,
      },
    });

  // Branch-diff (no-PR) reviews: clone + `git diff` + engine, delivered via the
  // task callback.
  const branchReview = new BranchReviewService({
    git: new ProcessCommandRunner(),
    createEngine,
    defaultEngine: config.review.defaultEngine,
    enabledEngines: config.review.enabledEngines,
    workspaceRoot: config.workspaceDir,
    onlyChangedLines: config.review.onlyChangedLines,
    recordUsage: (u) => void repo.recordTokenUsage(u).catch(() => {}),
  });

  const taskService = new TaskService({
    repo,
    providerFor,
    defaultEngine: config.review.defaultEngine,
    enabledEngines: config.review.enabledEngines,
    branchReview,
  });

  // Shared per-repo base-graph cache for structural context, used by BOTH the
  // PR-review path and the scheduled scans (built/refreshed once per repo,
  // queried read-only — concurrent reviews/scans share it without rebuilding).
  const graphCache = new GraphCacheService({
    cacheRoot: config.review.codeGraphCacheDir || "./data/graph-cache",
    launcher: config.review.codeGraphLauncher,
    ttlMs: config.review.codeGraphTtlMs,
    timeoutMs: config.worker.engineTimeoutMs,
  });

  // Scheduled daily scans: per-branch review of the day's changes + delivery.
  const scheduleStore = createScheduleStore(config);
  const scanService = new ScheduledScanService({
    git: new ProcessCommandRunner(),
    createEngine,
    defaultEngine: config.review.defaultEngine,
    enabledEngines: config.review.enabledEngines,
    workspaceRoot: config.workspaceDir,
    onlyChangedLines: config.review.onlyChangedLines,
    // Token-injected clone URL (via the provider) so private repos can be cloned.
    resolveCloneUrl: (platform, fullName) =>
      providerFor(platform).cloneUrl({ fullName }),
    graphCache,
    structuralContext: config.review.structuralContext,
    recordUsage: (u) => void repo.recordTokenUsage(u).catch(() => {}),
  });
  const scheduler = new Scheduler({
    store: scheduleStore,
    scan: scanService,
    ...(config.schedule.feishuWebhookUrl
      ? { defaultFeishuWebhook: config.schedule.feishuWebhookUrl }
      : {}),
    log: (line) => createLogger(config.logLevel).info(line),
  });
  const reviewService = new ReviewService({
    repo,
    config,
    providerFor,
    cloner:
      overrides.cloner ??
      new GitCloner(new ProcessCommandRunner(), {
        workspaceRoot: config.workspaceDir,
      }),
    graphCache,
  });
  const worker = new Worker(repo, reviewService, providerFor, {
    inlineComments: config.worker.inlineComments,
    publishCheckRun: config.worker.publishCheckRun,
    ...(config.worker.failOnSeverity
      ? { failOnSeverity: config.worker.failOnSeverity as Severity }
      : {}),
  });

  const server = startAppServer(
    {
      repo,
      taskService,
      ...(config.sessionSecret ? { sessionSecret: config.sessionSecret } : {}),
      sessionTtlMs: config.sessionTtlMs,
      adminEmail: config.adminEmail,
      ...(config.adminPassword ? { adminPassword: config.adminPassword } : {}),
      webDistDir: config.webDistDir,
      scheduleStore,
      scheduler,
    },
    config.port,
  );

  const log = createLogger(config.logLevel);

  // Initialise storage (indexes/migrations) then recover interrupted jobs.
  // The drain/poller gate on this so they never touch uninitialised storage.
  const ready = (async () => {
    await repo.init();
    await scheduleStore.init();
    // Clear any `running` flags stranded by a previous crash/redeploy.
    await scheduler.reconcileRunning();
    // Start the daily scheduler only if at least one enabled schedule exists.
    await scheduler.refresh();
    const recovered = config.worker.recoverInterruptedJobsOnStart
      ? await worker.recoverInterrupted()
      : 0;
    log.info("service ready", {
      port: config.port,
      db: config.db.driver,
      engine: config.review.defaultEngine,
      auth: config.sessionSecret ? "on" : "off",
      recoveredJobs: recovered,
      schedules: (await scheduleStore.list()).length,
    });
  })().catch((err) => {
    log.error("startup failed", { error: (err as Error).message });
    throw err;
  });

  // Periodic worker drain (unref'd so it never blocks shutdown).
  const drain = setInterval(() => {
    void ready
      .then(() => worker.runPending())
      .catch((err) => log.error("worker drain failed", { error: (err as Error).message }));
  }, overrides.drainIntervalMs ?? 5000);
  drain.unref?.();

  return {
    repo,
    worker,
    taskService,
    ready,
    close: async () => {
      clearInterval(drain);
      scheduler.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await scheduleStore.close();
      await repo.close();
    },
  };
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  const config = loadConfig();
  createLogger(config.logLevel).info("starting", { service: NAME, version: VERSION });
  startApp(config);
}
