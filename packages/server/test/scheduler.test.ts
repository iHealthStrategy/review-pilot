import assert from "node:assert/strict";
import { test } from "node:test";
import { FileScheduleStore } from "../src/schedule/file-schedule-store.js";
import type { ScanResult, ScheduledScanService } from "../src/schedule/scan-service.js";
import type { ScheduleConfig } from "../src/schedule/schedule.js";
import { Scheduler, shouldFire } from "../src/schedule/scheduler.js";

const cfg = (over: Partial<ScheduleConfig> = {}): ScheduleConfig => ({
  id: "sch_1",
  name: "nightly",
  platform: "github",
  repoFullName: "acme/demo",
  cloneUrl: "https://github.com/acme/demo.git",
  branches: ["main"],
  timeOfDay: "02:00",
  timezone: "Asia/Shanghai",
  lookbackHours: 24,
  delivery: { type: "feishu", webhookUrl: "https://hook" },
  enabled: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  ...over,
});

// 2026-06-10 02:30 Asia/Shanghai == 2026-06-09T18:30:00Z
const after = new Date("2026-06-09T18:30:00Z");
// 2026-06-10 01:30 Asia/Shanghai == 2026-06-09T17:30:00Z (before 02:00)
const before = new Date("2026-06-09T17:30:00Z");

test("shouldFire: only at/after the scheduled minute, once per day", () => {
  assert.equal(shouldFire(cfg(), before), false); // before 02:00 local
  assert.equal(shouldFire(cfg(), after), true); // at/after 02:00 local, never run

  // Already ran today (same local date) → no re-fire.
  const ranToday = cfg({ lastRunAt: "2026-06-09T18:00:00Z" }); // 2026-06-10 02:00 +08
  assert.equal(shouldFire(ranToday, after), false);

  // Last run was yesterday → fires again.
  const ranYesterday = cfg({ lastRunAt: "2026-06-08T18:00:00Z" });
  assert.equal(shouldFire(ranYesterday, after), true);

  assert.equal(shouldFire(cfg({ enabled: false }), after), true); // shouldFire ignores enabled (tick checks it)
});

function makeScheduler(store: FileScheduleStore, scanResult: ScanResult, sent: string[]) {
  const scan = {
    scan: async (): Promise<ScanResult> => scanResult,
  } as unknown as ScheduledScanService;
  return new Scheduler({
    store,
    scan,
    now: () => after,
    feishuSender: async (_url, body) => {
      sent.push(body);
      return { status: 200, text: '{"code":0}' };
    },
  });
}

test("Scheduler.tick: fires a due config, delivers, records lastRunAt + result", async () => {
  const store = new FileScheduleStore();
  await store.init();
  const c = await store.create({
    name: "n",
    platform: "github",
    repoFullName: "acme/demo",
    timeOfDay: "02:00",
    timezone: "Asia/Shanghai",
    delivery: { type: "feishu", webhookUrl: "https://hook" },
  });

  const sent: string[] = [];
  const scheduler = makeScheduler(store, {
    repoFullName: "acme/demo",
    date: "2026-06-10",
    branches: [{ branch: "main", commitCount: 1, findings: [{ filePath: "a.ts", severity: "minor", title: "t", detail: "d" }] }],
    totalFindings: 1,
  }, sent);

  await scheduler.tick();

  assert.equal(sent.length, 1); // delivered to Feishu
  assert.match(sent[0]!, /ReviewPilot/);
  const after1 = await store.get(c.id);
  assert.ok(after1?.lastRunAt);
  assert.match(after1?.lastResult ?? "", /ok: 1 finding/);

  // A second tick the same day does not re-fire.
  await scheduler.tick();
  assert.equal(sent.length, 1);
});

test("Scheduler: a schedule can't run concurrently; running flag + reconcile", async () => {
  const store = new FileScheduleStore();
  await store.init();
  const c = await store.create({
    name: "n", platform: "github", repoFullName: "a/b",
    timeOfDay: "02:00", delivery: { type: "feishu", webhookUrl: "h" },
  });

  // A scan that blocks until we release it, so we can observe an in-flight run.
  let release: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const scan = {
    scan: async (): Promise<ScanResult> => {
      await gate;
      return { repoFullName: "a/b", date: "2026-06-10", branches: [], totalFindings: 0 };
    },
  } as unknown as ScheduledScanService;
  const scheduler = new Scheduler({
    store, scan, now: () => after,
    feishuSender: async () => ({ status: 200, text: '{"code":0}' }),
  });

  const first = scheduler.runConfig(c); // starts, blocks on gate
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(scheduler.isRunning(c.id), true);
  assert.equal((await store.get(c.id))?.running, true);

  // A second trigger while running is rejected (returns null, no second run).
  assert.equal(await scheduler.runConfig(c), null);

  release!();
  await first;
  assert.equal(scheduler.isRunning(c.id), false);
  assert.equal((await store.get(c.id))?.running, false);

  // reconcileRunning clears a stale running flag (e.g. left by a crash).
  await store.update(c.id, { running: true });
  await scheduler.reconcileRunning();
  assert.equal((await store.get(c.id))?.running, false);
  assert.match((await store.get(c.id))?.lastResult ?? "", /中断/);
});

test("Scheduler.refresh: timer runs only while an enabled config exists", async () => {
  const store = new FileScheduleStore();
  await store.init();
  const scheduler = new Scheduler({ store, scan: {} as ScheduledScanService, now: () => after });

  await scheduler.refresh();
  assert.equal((scheduler as unknown as { timer: unknown }).timer, null); // no configs → no timer

  const c = await store.create({
    name: "n", platform: "github", repoFullName: "a/b",
    timeOfDay: "02:00", delivery: { type: "feishu", webhookUrl: "h" },
  });
  await scheduler.refresh();
  assert.notEqual((scheduler as unknown as { timer: unknown }).timer, null); // now running

  await store.update(c.id, { enabled: false });
  await scheduler.refresh();
  assert.equal((scheduler as unknown as { timer: unknown }).timer, null); // stopped
  scheduler.stop();
});
