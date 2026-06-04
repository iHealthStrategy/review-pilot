import { startAppServer } from "./app.js";
import { type AppConfig, loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import type { Platform, Severity } from "./domain/entities.js";
import { createRepository } from "./persistence/factory.js";
import type { Repository } from "./persistence/repository.js";
import { createGitProvider } from "./providers/factory.js";
import type { GitProvider } from "./providers/git-provider.js";
import { type Cloner, GitCloner } from "./review/cloner.js";
import { ProcessCommandRunner } from "./review/command-runner.js";
import { ReviewService } from "./review/review-service.js";
import { Poller } from "./trigger/poller.js";
import { TriggerService } from "./trigger/trigger-service.js";
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
  triggerService: TriggerService;
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

  const triggerService = new TriggerService({
    repo,
    providerFor,
    defaultEngine: config.review.defaultEngine,
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
  });
  const worker = new Worker(repo, reviewService, providerFor, {
    inlineComments: config.worker.inlineComments,
    publishCheckRun: config.worker.publishCheckRun,
    ...(config.worker.failOnSeverity
      ? { failOnSeverity: config.worker.failOnSeverity as Severity }
      : {}),
  });

  const poller = new Poller(triggerService, config.trigger.pollIntervalSeconds);
  const server = startAppServer(
    {
      repo,
      triggerService,
      apiToken: config.apiToken,
      webDistDir: config.webDistDir,
    },
    config.port,
  );

  const log = createLogger(config.logLevel);

  // Initialise storage (indexes/migrations) then recover interrupted jobs.
  // The drain/poller gate on this so they never touch uninitialised storage.
  const ready = (async () => {
    await repo.init();
    const recovered = config.worker.recoverInterruptedJobsOnStart
      ? await worker.recoverInterrupted()
      : 0;
    log.info("service ready", {
      port: config.port,
      db: config.db.driver,
      engine: config.review.defaultEngine,
      poll: config.trigger.pollIntervalSeconds,
      auth: config.apiToken ? "on" : "off",
      recoveredJobs: recovered,
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
  void ready.then(() => poller.start()).catch(() => {});

  return {
    repo,
    worker,
    triggerService,
    ready,
    close: async () => {
      clearInterval(drain);
      poller.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
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
