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
  // Sidebar nav switches the Dashboard + New task views.
  assert.match(html, /data-view="dashboard"/);
  assert.match(html, /data-view="new"/);
  // Task list + manual new-task form are present.
  assert.match(html, /id="jobs"/);
  assert.match(html, /id="task-form"/);
  // Scheduled-scans view + form.
  assert.match(html, /data-view="schedules"/);
  assert.match(html, /id="schedule-form"/);
  // Embedded mock data hydrates the UI standalone and hits the REST API at runtime.
  assert.match(html, /id="mock-data"/);
  assert.match(html, /\/api\/tasks/);
  assert.match(html, /\/api\/jobs/);
  assert.match(html, /\/api\/schedules/);
});
