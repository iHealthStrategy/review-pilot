import * as path from "node:path";
import * as vscode from "vscode";
import type { FindingDraft } from "../../../server/src/review/review-engine.js";
import type { Severity } from "../../../server/src/domain/entities.js";

const DIAGNOSTIC_SOURCE = "ReviewPilot";

function toDiagnosticSeverity(severity: Severity): vscode.DiagnosticSeverity {
  switch (severity) {
    case "critical":
    case "major":
      return vscode.DiagnosticSeverity.Error;
    case "minor":
      return vscode.DiagnosticSeverity.Warning;
    default:
      return vscode.DiagnosticSeverity.Information;
  }
}

/** Whole-line range for a 1-based finding line (0-based, end-exclusive in VS Code). */
export function findingRange(finding: FindingDraft): vscode.Range {
  const startLine = Math.max(0, (finding.line ?? 1) - 1);
  const endLine = Math.max(startLine, (finding.endLine ?? finding.line ?? 1) - 1);
  return new vscode.Range(startLine, 0, endLine, Number.MAX_SAFE_INTEGER);
}

/**
 * Publish findings as diagnostics so they show inline (squiggles) and in the
 * Problems panel. Paths are repo-relative; resolve them against the workspace.
 */
export function publishDiagnostics(
  collection: vscode.DiagnosticCollection,
  workspaceDir: string,
  findings: readonly FindingDraft[],
): void {
  collection.clear();
  const byFile = new Map<string, vscode.Diagnostic[]>();
  for (const finding of findings) {
    const message = finding.suggestion
      ? `${finding.title}\n\n${finding.detail}\n\n💡 ${finding.suggestion}`
      : `${finding.title}\n\n${finding.detail}`;
    const diagnostic = new vscode.Diagnostic(
      findingRange(finding),
      message,
      toDiagnosticSeverity(finding.severity),
    );
    diagnostic.source = DIAGNOSTIC_SOURCE;
    if (finding.category) diagnostic.code = finding.category;
    const abs = path.resolve(workspaceDir, finding.filePath);
    const list = byFile.get(abs) ?? [];
    list.push(diagnostic);
    byFile.set(abs, list);
  }
  for (const [abs, list] of byFile) {
    collection.set(vscode.Uri.file(abs), list);
  }
}
