import { readFile, writeFile } from "node:fs/promises";
import type { ReviewEngineKind } from "../domain/entities.js";
import { GitHubProvider } from "../providers/github-provider.js";
import type { GitProvider } from "../providers/git-provider.js";
import { FetchHttpClient } from "../providers/http-client.js";
import { createReviewEngine } from "../review/engine-factory.js";
import type { ReviewContext, ReviewEngine } from "../review/review-engine.js";
import type { CheckConclusion } from "../providers/git-provider.js";
import { buildCheckRun } from "../review/check-run.js";
import { filterToChangedLines } from "../review/diff-lines.js";
import { isSeverity } from "../review/severity.js";
import { scanStructure } from "../review/structure-scanner.js";
import { deliverSummaryComment, formatFindingsComment } from "../worker/comment-format.js";

/**
 * One-shot, STATELESS review for a single PR — the GitHub Actions deployment.
 * GitHub triggers an ephemeral runner per PR; this reads the PR context from
 * the Actions environment, uses the already-checked-out repo as the workspace,
 * runs the configured engine, and writes the result back to the PR with the
 * job's GITHUB_TOKEN. No server, no database, no webhook: the PR is the store.
 *
 * The whole-project understanding can be cached across runs via a file
 * (PROJECT_INSIGHT_FILE) that the workflow persists with actions/cache.
 */
export interface ActionDeps {
  env: Record<string, string | undefined>;
  /** Read + parse the GitHub event payload (GITHUB_EVENT_PATH). Optional when
   * the PR number is supplied directly via the PR_NUMBER env (local runs). */
  readEvent?: (path: string) => Promise<EventPayload>;
  provider: GitProvider;
  engine: ReviewEngine;
  engineKind: ReviewEngineKind;
  scan?: (dir: string) => Promise<string[]>;
  /** Read the cached project-understanding summary (if any). */
  readInsight?: () => Promise<string | undefined>;
  /** Persist the project-understanding summary for reuse. */
  writeInsight?: (summary: string) => Promise<void>;
  /** Append to the Actions job summary (optional). */
  writeSummary?: (markdown: string) => Promise<void>;
  log?: (line: string) => void;
}

interface EventPayload {
  number?: number;
  pull_request?: { number?: number };
  repository?: { full_name?: string };
}

export interface ActionResult {
  prNumber: number;
  findings: number;
  commentId: string;
  conclusion: CheckConclusion;
  /** True when FAIL_ON_SEVERITY tripped — the caller should exit non-zero. */
  gateFailed: boolean;
}

export async function runReviewAction(deps: ActionDeps): Promise<ActionResult> {
  const { env } = deps;
  const log = deps.log ?? (() => {});
  const repoFullName = required(env, "GITHUB_REPOSITORY");
  const workspace = required(env, "GITHUB_WORKSPACE");

  // Resolve the PR number from PR_NUMBER (local/manual runs) or the Actions
  // event payload. PR_NUMBER makes the entrypoint runnable by hand with no
  // event file — handy for a small local trial using your subscription.
  let number: number | undefined;
  let repoRef = { fullName: repoFullName };
  if (env.PR_NUMBER) {
    number = Number.parseInt(env.PR_NUMBER, 10);
  } else {
    const eventPath = required(env, "GITHUB_EVENT_PATH");
    if (!deps.readEvent) throw new Error("readEvent is required when PR_NUMBER is unset");
    const event = await deps.readEvent(eventPath);
    number = event.pull_request?.number ?? event.number;
    if (event.repository?.full_name) repoRef = { fullName: event.repository.full_name };
  }
  if (number === undefined || Number.isNaN(number)) {
    throw new Error("no pull request number (set PR_NUMBER, or trigger on a pull_request event)");
  }

  log(`reviewing ${repoRef.fullName} PR #${number} with engine '${deps.engineKind}'`);
  const pr = await deps.provider.getPullRequest(repoRef, number);
  const diff = await deps.provider.getPullRequestDiff(repoRef, number);
  const structure = await (deps.scan ?? scanStructure)(workspace);

  const context: ReviewContext = {
    platform: "github",
    repoFullName: repoRef.fullName,
    pullRequest: {
      number,
      title: pr.title,
      sourceBranch: pr.sourceBranch,
      targetBranch: pr.targetBranch,
      headSha: pr.headSha,
      author: pr.author,
      url: pr.url,
    },
    structure,
    diff,
    workspaceDir: workspace,
  };

  // Ground the review in cached project understanding; generate + cache it on a
  // miss when the engine can explore. Freshness is the cache key's job (workflow).
  let insight = await deps.readInsight?.();
  if (!insight && deps.engine.summarize) {
    log("no cached project understanding; generating one");
    insight = (await deps.engine.summarize(context)).trim();
    await deps.writeInsight?.(insight);
  }
  if (insight) context.projectInsight = insight;

  const produced = await deps.engine.review(context);
  const findings =
    env.ONLY_CHANGED_LINES === "true"
      ? filterToChangedLines(produced, diff)
      : produced;
  log(
    `engine produced ${produced.length} finding(s)` +
      (findings.length !== produced.length ? `, ${findings.length} on changed lines` : ""),
  );

  const body = formatFindingsComment(findings, {
    engine: deps.engineKind,
    prNumber: number,
  });
  const comment = await deliverSummaryComment(deps.provider, repoRef, number, body);
  log(`delivered summary comment ${comment.id}`);
  await deps.writeSummary?.(body);

  // Severity gate + inline annotations → check run (shared with the Worker).
  const rawThreshold = env.FAIL_ON_SEVERITY;
  const threshold =
    rawThreshold && isSeverity(rawThreshold) ? rawThreshold : undefined;
  const { checkRun, gateFailed: failed, conclusion } = buildCheckRun(findings, {
    name: env.CHECK_RUN_NAME ?? "ReviewPilot",
    headSha: pr.headSha,
    summary: body,
    ...(threshold ? { threshold } : {}),
  });

  if (deps.provider.createCheckRun && env.CHECK_RUN !== "false") {
    const check = await deps.provider.createCheckRun(repoRef, checkRun);
    log(
      `published check run ${check.id} (${conclusion}, ${checkRun.annotations?.length ?? 0} annotation(s))`,
    );
  }
  if (failed) log(`severity gate tripped (FAIL_ON_SEVERITY=${threshold})`);

  return {
    prNumber: number,
    findings: findings.length,
    commentId: comment.id,
    conclusion,
    gateFailed: failed,
  };
}

function required(env: Record<string, string | undefined>, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`missing required environment variable: ${key}`);
  return v;
}

/** Wire real dependencies from the Actions environment and run. */
export async function main(rawEnv: NodeJS.ProcessEnv = process.env): Promise<void> {
  // Default the workspace to the cwd so the entrypoint is runnable locally from
  // inside a checkout (e.g. a subscription-based manual trial).
  const env: NodeJS.ProcessEnv = {
    ...rawEnv,
    GITHUB_WORKSPACE: rawEnv.GITHUB_WORKSPACE ?? process.cwd(),
  };
  const engineKind = (env.REVIEW_ENGINE ?? "claude-agent") as ReviewEngineKind;
  const provider = new GitHubProvider(new FetchHttpClient(), {
    apiBase: env.GITHUB_API_URL ?? "https://api.github.com",
    token: env.GITHUB_TOKEN ?? "",
    webhookSecret: "",
  });
  const engine = createReviewEngine(engineKind, {
    ...(env.ENGINE_TIMEOUT_MS ? { timeoutMs: Number.parseInt(env.ENGINE_TIMEOUT_MS, 10) } : {}),
    agent: {
      ...(env.REVIEW_AGENT_MODEL ? { model: env.REVIEW_AGENT_MODEL } : {}),
      ...(env.REVIEW_AGENT_MAX_TURNS
        ? { maxTurns: Number.parseInt(env.REVIEW_AGENT_MAX_TURNS, 10) }
        : {}),
    },
  });

  const insightFile = env.PROJECT_INSIGHT_FILE;
  const summaryFile = env.GITHUB_STEP_SUMMARY;

  const result = await runReviewAction({
    env,
    engine,
    engineKind,
    provider,
    readEvent: async (p) => JSON.parse(await readFile(p, "utf8")) as EventPayload,
    log: (l) => process.stdout.write(l + "\n"),
    ...(insightFile
      ? {
          readInsight: async () => {
            try {
              return await readFile(insightFile, "utf8");
            } catch {
              return undefined;
            }
          },
          writeInsight: async (s: string) => writeFile(insightFile, s, "utf8"),
        }
      : {}),
    ...(summaryFile
      ? { writeSummary: async (md: string) => writeFile(summaryFile, md + "\n", { flag: "a" }) }
      : {}),
  });

  // Fail the job (and the required check) when the severity gate tripped.
  if (result.gateFailed) {
    process.stderr.write(
      `reviewpilot: blocking — findings met FAIL_ON_SEVERITY=${env.FAIL_ON_SEVERITY}\n`,
    );
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`reviewpilot-action failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
