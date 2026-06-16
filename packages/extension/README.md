# ReviewPilot (VS Code / Cursor extension)

A local-running build of ReviewPilot. It reviews the **current project** with the
same review engine as the ReviewPilot server, produces a list of findings in the
sidebar, and lets you click a finding to jump to the exact code and read a fix
suggestion. Findings also appear inline (squiggles) and in the Problems panel.

The same extension runs in **VS Code** and **Cursor** (Cursor is a VS Code
derivative). The review logic lives in `src/core/` (no editor dependency) and is
reused from `packages/server` — the editor layer in `src/vscode/` only renders it.

## Usage

1. Open a project folder.
2. Run **ReviewPilot: Review Project** (Command Palette) or the ▶ button in the
   ReviewPilot sidebar.
3. Choose a scope:
   - **Working changes** — uncommitted changes vs `HEAD` (plus new files).
   - **Branch diff** — current branch vs a base branch you pick.
   - **Whole project** — audit the entire codebase.
4. Findings appear in the **ReviewPilot** sidebar, grouped by file. Click one to
   open the file at the reported line; the suggestion shows in the tooltip and the
   ReviewPilot output channel.

## Requirements

The default engine shells out to the **Claude Code CLI** (`claude`), using your
existing login. Install it and make sure it's on `PATH`, or set
`reviewpilot.command` to its absolute path. Other engines (`cursor`, `codex`,
`claude-agent`, `mock`) are selectable via `reviewpilot.engine`.

## Settings

`reviewpilot.engine`, `reviewpilot.command`, `reviewpilot.args`,
`reviewpilot.model`, `reviewpilot.timeoutMs`, `reviewpilot.defaultMode`,
`reviewpilot.baseBranch`, `reviewpilot.onlyChangedLines`,
`reviewpilot.reviewFocus` — see the Settings UI (search "ReviewPilot").

## Develop

```bash
npm install            # from the repo root (workspaces)
npm run -w reviewpilot-vscode lint    # type-check
npm run -w reviewpilot-vscode test    # core unit tests
npm run -w reviewpilot-vscode build   # bundle to dist/extension.js (esbuild)
```

Press <kbd>F5</kbd> (Run "Run ReviewPilot Extension") to launch an Extension
Development Host. Package a `.vsix` with `npx vsce package` for installing into
VS Code or Cursor.
