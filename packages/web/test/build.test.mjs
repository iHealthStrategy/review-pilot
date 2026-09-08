import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("web build emits a static index.html artifact", async () => {
  const dist = resolve(root, "dist");
  await rm(dist, { recursive: true, force: true });
  await run(process.execPath, [resolve(root, "scripts/build.mjs")]);
  const html = await readFile(resolve(dist, "index.html"), "utf8");
  assert.match(html, /ReviewPilot/);
  // Sidebar "任务" view holds both scheduled (定时任务) + one-time (一次性任务) tasks.
  assert.match(html, /data-view="tasks"/);
  assert.match(html, /id="view-tasks"/);
  assert.match(html, /定时任务/);
  assert.match(html, /一次性任务/);
  // Both creation forms live in modal dialogs opened by "+ New" buttons.
  assert.match(html, /id="open-schedule-modal"/);
  assert.match(html, /id="open-task-modal"/);
  assert.match(html, /id="schedule-modal"[^>]*data-modal/);
  assert.match(html, /id="task-modal"[^>]*data-modal/);
  assert.match(html, /id="schedule-form"/);
  assert.match(html, /id="task-form"/);
  // Task + schedule lists.
  assert.match(html, /id="jobs"/);
  assert.match(html, /id="schedules"/);
  // Scheduled-scan detail viewer (per-branch findings from lastScan).
  assert.match(html, /id="scan-modal"/);
  assert.match(html, /data-view-id/);
  assert.match(html, /lastScan/);
  // Embedded mock data hydrates the UI standalone and hits the REST API at runtime.
  assert.match(html, /id="mock-data"/);
  assert.match(html, /\/api\/tasks/);
  assert.match(html, /\/api\/jobs/);
  assert.match(html, /\/api\/schedules/);
  // State survives refresh: view restored from hash (with localStorage fallback),
  // open job detail encoded as #tasks/<id>, usage time range persisted.
  assert.match(html, /localStorage.getItem\("rp_view"\)/);
  assert.match(html, /location.hash = "tasks\/"/);
  assert.match(html, /rp_range/);
  // The usage control is a time RANGE, and every label states the window it
  // actually scans — the old day/week/month buttons scanned 30/84/366 days.
  for (const range of ["7d", "30d", "90d", "365d"]) {
    assert.match(html, new RegExp(`data-range="${range}"`));
  }
  assert.match(html, /近 7 天/);
  assert.doesNotMatch(html, /data-bucket=/, "the granularity control is gone");
  // Admin overview of everyone's rulesets (private ones included), grouped by
  // user, with a filter — and the usage table's 规则贡献 cell links into it.
  assert.match(html, /\/api\/rulesets\?scope=all/);
  assert.match(html, /全部用户规则集/);
  assert.match(html, /id="rs-admin-filter"/);
  assert.match(html, /id="rs-admin-list"/);
  assert.match(html, /data-rules-of=/);
  // Project-level mandatory rules: a section everyone can read, plus the admin
  // promote/demote flow that fills it.
  assert.match(html, /\/api\/project-rules/);
  assert.match(html, /项目必选规则/);
  assert.match(html, /id="promote-modal"/);
  assert.match(html, /id="promote-form"/);
  assert.match(html, /data-promote-rs=/);
  assert.match(html, /data-demote-project=/);
  assert.match(html, /project-rules\/promote/);
  assert.match(html, /project-rules\/demote/);
});

test("layout: one line per cell, and nothing but a scroll container scrolls sideways", async () => {
  const html = await readFile(resolve(root, "dist", "index.html"), "utf8");
  // Cells never wrap; long values clip with the full text in a tooltip, and an
  // over-wide table scrolls inside .table-wrap.
  assert.match(html, /th, td \{ white-space: nowrap; \}/);
  assert.match(html, /td\.clip \{[^}]*text-overflow: ellipsis/);
  assert.match(html, /\.table-wrap > table \{ width: max-content; min-width: 100%; \}/);
  // Action buttons: one inline-block group per cell, so the column is sized to
  // the buttons and rows align.
  assert.match(html, /\.btn-row \{ display: inline-block; white-space: nowrap; \}/);
  assert.match(html, /<td class="actions"><span class="btn-row">/);
  // min-width:0 on every flex/grid ancestor of wide content — without it the
  // PAGE scrolls sideways instead of the container.
  assert.match(html, /main \{[^}]*min-width: 0/);
  assert.match(html, /\.inst-grid \{ display: grid; grid-template-columns: minmax\(0, 1fr\)/);
  // Install commands: one line with the token abbreviated for display, while
  // the copy button carries the real command.
  assert.match(html, /function elideSecret/);
  assert.match(html, /<pre data-copy="/);
  assert.match(html, /pre\.dataset\.copy \|\| pre\.innerText/);
  assert.match(html, /pre code \{[^}]*word-break: normal/);
});

test("the embedded app script is syntactically valid JS", async () => {
  const dist = resolve(root, "dist");
  await run(process.execPath, [resolve(root, "scripts/build.mjs")]);
  const html = await readFile(resolve(dist, "index.html"), "utf8");
  // Grab the last <script>…</script> (the app, not the JSON mock-data block).
  const parts = html.split(/<script[^>]*>/);
  const appJs = parts[parts.length - 1].split("</script>")[0];
  const tmp = resolve(dist, "__app.check.mjs");
  await writeFile(tmp, appJs);
  // `node --check` parses without executing; a syntax error rejects (non-zero).
  await run(process.execPath, ["--check", tmp]);
  await rm(tmp, { force: true });
});
