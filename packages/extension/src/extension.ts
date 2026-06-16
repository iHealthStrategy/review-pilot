import * as vscode from "vscode";
import { ProcessCommandRunner } from "../../server/src/review/command-runner.js";
import type { ReviewEngineKind } from "../../server/src/domain/entities.js";
import { runLocalReview, type LocalReviewOptions } from "./core/local-review.js";
import { currentBranch, listBranches, type LocalReviewMode } from "./core/local-git.js";
import { publishDiagnostics, findingRange } from "./vscode/diagnostics.js";
import { FindingsProvider, type LocatedFinding } from "./vscode/findings-provider.js";

let output: vscode.OutputChannel;
let diagnostics: vscode.DiagnosticCollection;
let provider: FindingsProvider;
let running = false;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("ReviewPilot");
  diagnostics = vscode.languages.createDiagnosticCollection("reviewpilot");
  provider = new FindingsProvider();

  context.subscriptions.push(
    output,
    diagnostics,
    vscode.window.registerTreeDataProvider("reviewpilotFindings", provider),
    vscode.commands.registerCommand("reviewpilot.review", () => runReview()),
    vscode.commands.registerCommand("reviewpilot.clear", () => {
      provider.clear();
      diagnostics.clear();
    }),
    vscode.commands.registerCommand("reviewpilot.openFinding", (located: LocatedFinding) =>
      openFinding(located),
    ),
  );
}

export function deactivate(): void {
  /* disposables handled by context.subscriptions */
}

const MODE_PICKS: ReadonlyArray<{ label: string; detail: string; mode: LocalReviewMode }> = [
  { label: "$(git-commit) Working changes", detail: "Uncommitted changes vs HEAD (plus new files)", mode: "working" },
  { label: "$(git-branch) Branch diff", detail: "Current branch vs a base branch", mode: "branch" },
  { label: "$(repo) Whole project", detail: "Audit the entire project (slower)", mode: "full" },
];

async function runReview(): Promise<void> {
  if (running) {
    vscode.window.showWarningMessage("ReviewPilot: a review is already running.");
    return;
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showErrorMessage("ReviewPilot: open a folder/workspace first.");
    return;
  }
  const workspaceDir = folder.uri.fsPath;
  const config = vscode.workspace.getConfiguration("reviewpilot");
  const defaultMode = config.get<LocalReviewMode>("defaultMode", "working");

  const ordered = [...MODE_PICKS].sort((a, b) =>
    a.mode === defaultMode ? -1 : b.mode === defaultMode ? 1 : 0,
  );
  const modePick = await vscode.window.showQuickPick(ordered, {
    title: "ReviewPilot: choose review scope",
    placeHolder: "What should be reviewed?",
  });
  if (!modePick) return;
  const mode = modePick.mode;

  let baseBranch = config.get<string>("baseBranch", "main");
  if (mode === "branch") {
    const picked = await pickBaseBranch(workspaceDir, baseBranch);
    if (picked === undefined) return;
    baseBranch = picked;
  }

  const options: LocalReviewOptions = {
    mode,
    baseBranch,
    engineKind: config.get<ReviewEngineKind>("engine", "claude-code"),
    command: config.get<string>("command", ""),
    args: config.get<string[]>("args", []),
    model: config.get<string>("model", ""),
    timeoutMs: config.get<number>("timeoutMs", 600000),
    onlyChangedLines: config.get<boolean>("onlyChangedLines", false),
    reviewFocus: config.get<string>("reviewFocus", ""),
    structuralContext: config.get<boolean>("structuralContext", true),
    crgLauncher: config.get<string>("crgLauncher", "uvx"),
  };

  running = true;
  output.clear();
  output.appendLine(`ReviewPilot: ${mode} review (${options.engineKind}) in ${workspaceDir}`);
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "ReviewPilot: reviewing…",
        cancellable: false,
      },
      async (progress) => {
        const findings = await runLocalReview(workspaceDir, options, {
          onLog: (m) => {
            output.appendLine(m);
            progress.report({ message: m });
          },
        });
        provider.setFindings(workspaceDir, findings);
        publishDiagnostics(diagnostics, workspaceDir, findings);
        if (findings.length === 0) {
          vscode.window.showInformationMessage("ReviewPilot: no issues found. 🎉");
        } else {
          vscode.window.showInformationMessage(
            `ReviewPilot: ${findings.length} finding(s). See the ReviewPilot panel.`,
          );
          await vscode.commands.executeCommand("reviewpilotFindings.focus");
        }
      },
    );
  } catch (err) {
    reportError(err, options.engineKind ?? "claude-code");
  } finally {
    running = false;
  }
}

async function pickBaseBranch(
  workspaceDir: string,
  fallback: string,
): Promise<string | undefined> {
  const runner = new ProcessCommandRunner();
  let branches: string[] = [];
  try {
    branches = await listBranches(runner, workspaceDir);
  } catch {
    /* not a git repo / no branches — fall through to manual input */
  }
  const current = await currentBranch(runner, workspaceDir);
  const candidates = branches.filter((b) => b !== current);
  if (candidates.length === 0) {
    return vscode.window.showInputBox({
      title: "ReviewPilot: base branch",
      prompt: "Compare the current branch against which base branch?",
      value: fallback,
    });
  }
  const ordered = candidates.sort((a, b) =>
    a === fallback ? -1 : b === fallback ? 1 : a.localeCompare(b),
  );
  const picked = await vscode.window.showQuickPick(ordered, {
    title: "ReviewPilot: base branch",
    placeHolder: `Compare ${current || "HEAD"} against…`,
  });
  return picked;
}

async function openFinding(located: LocatedFinding): Promise<void> {
  const { finding, workspaceDir } = located;
  const abs = vscode.Uri.joinPath(vscode.Uri.file(workspaceDir), finding.filePath);
  try {
    const doc = await vscode.workspace.openTextDocument(abs);
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    const range = findingRange(finding);
    editor.selection = new vscode.Selection(range.start, range.start);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  } catch {
    vscode.window.showWarningMessage(
      `ReviewPilot: could not open ${finding.filePath}.`,
    );
  }
  if (finding.suggestion) {
    output.appendLine(`\n[${finding.severity}] ${finding.filePath}:${finding.line ?? "?"} — ${finding.title}`);
    output.appendLine(`  ${finding.detail}`);
    output.appendLine(`  💡 ${finding.suggestion}`);
  }
}

function reportError(err: unknown, engineKind: ReviewEngineKind): void {
  const message = err instanceof Error ? err.message : String(err);
  output.appendLine(`ERROR: ${message}`);
  const looksMissing = /ENOENT|not found|exited 127/i.test(message);
  const hint =
    looksMissing && engineKind !== "mock"
      ? ` The '${engineKind}' CLI may not be installed or on PATH. Set "reviewpilot.command" to its absolute path, or switch "reviewpilot.engine".`
      : "";
  vscode.window
    .showErrorMessage(`ReviewPilot: review failed. ${message}${hint}`, "Show Log")
    .then((choice) => {
      if (choice === "Show Log") output.show();
    });
}
