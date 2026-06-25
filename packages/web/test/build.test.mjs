import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
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
});
