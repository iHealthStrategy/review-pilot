import type { Severity } from "../domain/entities.js";

/** Ordinal ranking of severities (higher = worse). */
export const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  minor: 1,
  major: 2,
  critical: 3,
};

/** Type guard for a severity string. */
export function isSeverity(value: string): value is Severity {
  return value in SEVERITY_RANK;
}

/** Map a severity to a GitHub check-annotation level. */
export function annotationLevel(
  severity: Severity,
): "notice" | "warning" | "failure" {
  if (severity === "critical" || severity === "major") return "failure";
  if (severity === "minor") return "warning";
  return "notice";
}

/**
 * Whether any finding meets/exceeds the gate threshold — i.e. the review should
 * fail the check (and block the merge when the check is required).
 */
export function gateFailed(
  findings: ReadonlyArray<{ severity: Severity }>,
  threshold: Severity,
): boolean {
  const min = SEVERITY_RANK[threshold];
  return findings.some((f) => SEVERITY_RANK[f.severity] >= min);
}
