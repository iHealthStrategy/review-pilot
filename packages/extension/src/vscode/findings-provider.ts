import * as path from "node:path";
import * as vscode from "vscode";
import type { FindingDraft } from "../../../server/src/review/review-engine.js";
import type { Severity } from "../../../server/src/domain/entities.js";
import { SEVERITY_RANK } from "../../../server/src/review/severity.js";

/** A finding plus the workspace it belongs to (for absolute-path navigation). */
export interface LocatedFinding {
  finding: FindingDraft;
  workspaceDir: string;
}

/** Tree node: a file group (parent) or a single finding (leaf). */
type Node =
  | { kind: "file"; filePath: string; findings: LocatedFinding[] }
  | { kind: "finding"; located: LocatedFinding };

const SEVERITY_ICON: Record<Severity, vscode.ThemeIcon> = {
  critical: new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground")),
  major: new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground")),
  minor: new vscode.ThemeIcon("warning", new vscode.ThemeColor("editorWarning.foreground")),
  info: new vscode.ThemeIcon("info"),
};

/**
 * Backs the "Findings" tree view. Two levels: files (sorted by worst severity,
 * then path) → findings (sorted by severity, then line). Clicking a finding
 * runs `reviewpilot.openFinding` to navigate and reveal the suggestion.
 */
export class FindingsProvider implements vscode.TreeDataProvider<Node> {
  private findings: LocatedFinding[] = [];
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  setFindings(workspaceDir: string, findings: readonly FindingDraft[]): void {
    this.findings = findings.map((finding) => ({ finding, workspaceDir }));
    this.emitter.fire();
  }

  clear(): void {
    this.findings = [];
    this.emitter.fire();
  }

  get count(): number {
    return this.findings.length;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "file") {
      const item = new vscode.TreeItem(
        path.basename(node.filePath),
        vscode.TreeItemCollapsibleState.Expanded,
      );
      const dir = path.dirname(node.filePath);
      item.description = `${dir === "." ? "" : dir + " · "}${node.findings.length}`;
      item.resourceUri = vscode.Uri.file(
        path.resolve(node.findings[0]!.workspaceDir, node.filePath),
      );
      item.iconPath = vscode.ThemeIcon.File;
      item.contextValue = "reviewpilotFile";
      return item;
    }

    const { finding } = node.located;
    const item = new vscode.TreeItem(
      finding.title,
      vscode.TreeItemCollapsibleState.None,
    );
    const loc = finding.line ? `Ln ${finding.line}` : "file";
    item.description = `${finding.severity} · ${loc}`;
    item.iconPath = SEVERITY_ICON[finding.severity];
    item.tooltip = buildTooltip(finding);
    item.contextValue = "reviewpilotFinding";
    item.command = {
      command: "reviewpilot.openFinding",
      title: "Open Finding",
      arguments: [node.located],
    };
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (!node) return this.fileNodes();
    if (node.kind === "file") {
      return [...node.findings]
        .sort(
          (a, b) =>
            SEVERITY_RANK[b.finding.severity] - SEVERITY_RANK[a.finding.severity] ||
            (a.finding.line ?? 0) - (b.finding.line ?? 0),
        )
        .map((located) => ({ kind: "finding" as const, located }));
    }
    return [];
  }

  private fileNodes(): Node[] {
    const groups = new Map<string, LocatedFinding[]>();
    for (const located of this.findings) {
      const key = located.finding.filePath;
      const list = groups.get(key) ?? [];
      list.push(located);
      groups.set(key, list);
    }
    const worst = (list: LocatedFinding[]) =>
      Math.max(...list.map((l) => SEVERITY_RANK[l.finding.severity]));
    return [...groups.entries()]
      .sort(([pa, la], [pb, lb]) => worst(lb) - worst(la) || pa.localeCompare(pb))
      .map(([filePath, findings]) => ({ kind: "file" as const, filePath, findings }));
  }
}

function buildTooltip(finding: FindingDraft): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${finding.title}**  \n`);
  md.appendMarkdown(`_${finding.severity}${finding.category ? ` · ${finding.category}` : ""}_\n\n`);
  if (finding.detail) md.appendMarkdown(`${finding.detail}\n\n`);
  if (finding.suggestion) {
    md.appendMarkdown(`**Suggestion**\n\n`);
    md.appendMarkdown(`${finding.suggestion}\n`);
  }
  return md;
}
