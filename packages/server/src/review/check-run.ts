import type { Severity } from "../domain/entities.js";
import type {
  CheckAnnotation,
  CheckConclusion,
  CheckRunInput,
} from "../providers/git-provider.js";
import { annotationLevel, gateFailed } from "./severity.js";

/** Finding fields needed to build a check run (Finding and FindingDraft satisfy this). */
export interface AnnotationFinding {
  filePath: string;
  severity: Severity;
  title: string;
  detail: string;
  line?: number;
  endLine?: number;
  suggestion?: string;
}

export interface BuildCheckRunOptions {
  name: string;
  headSha: string;
  /** Markdown summary (the same body posted as the PR comment). */
  summary: string;
  /** Gate threshold; when a finding meets it the check fails. */
  threshold?: Severity;
}

/**
 * Build the Check Run payload from findings: the conclusion (severity gate),
 * the inline annotations (one per finding that carries a line), and whether the
 * gate tripped. Shared by the GitHub Action and the long-running Worker so both
 * deployments publish identical checks.
 */
export function buildCheckRun(
  findings: ReadonlyArray<AnnotationFinding>,
  opts: BuildCheckRunOptions,
): { checkRun: CheckRunInput; gateFailed: boolean; conclusion: CheckConclusion } {
  const failed = opts.threshold ? gateFailed(findings, opts.threshold) : false;
  const conclusion: CheckConclusion = failed
    ? "failure"
    : findings.length > 0
      ? "neutral"
      : "success";
  const annotations: CheckAnnotation[] = findings
    .filter((f) => f.line !== undefined)
    .map((f) => ({
      path: f.filePath,
      startLine: f.line as number,
      endLine: f.endLine ?? (f.line as number),
      level: annotationLevel(f.severity),
      title: f.title,
      message: f.suggestion ? `${f.detail}\n\n💡 ${f.suggestion}` : f.detail,
    }));
  const title =
    `${findings.length} finding(s)` +
    (opts.threshold ? ` · gate: fail on ${opts.threshold}+` : "");
  return {
    checkRun: { name: opts.name, headSha: opts.headSha, conclusion, title, summary: opts.summary, annotations },
    gateFailed: failed,
    conclusion,
  };
}
