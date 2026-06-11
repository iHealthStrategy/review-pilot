import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { startAppServer } from "../src/app.js";
import type { Platform } from "../src/domain/entities.js";
import { MemoryRepository } from "../src/persistence/memory-repository.js";
import type { ScanResult, ScheduledScanService } from "../src/schedule/scan-service.js";
import { FileScheduleStore } from "../src/schedule/file-schedule-store.js";
import { Scheduler } from "../src/schedule/scheduler.js";
import { TaskService } from "../src/trigger/trigger-service.js";
import { fixedClock, seqIdGen } from "./repository-contract.js";
import { SpyProvider } from "./spy-provider.js";

async function start() {
  const repo = new MemoryRepository({ clock: fixedClock(), idGen: seqIdGen() });
  await repo.init();
  let n = 0;
  const scheduleStore = new FileScheduleStore({ clock: fixedClock(), idGen: () => `sch_${++n}` });
  await scheduleStore.init();

  const sent: string[] = [];
  const scan = {
    scan: async (): Promise<ScanResult> => ({
      repoFullName: "acme/demo",
      date: "2026-06-10",
      branches: [{ branch: "main", commitCount: 1, findings: [] }],
      totalFindings: 0,
    }),
  } as unknown as ScheduledScanService;
  const scheduler = new Scheduler({
    store: scheduleStore,
    scan,
    feishuSender: async (_u, b) => { sent.push(b); return { status: 200, text: '{"code":0}' }; },
  });
  const taskService = new TaskService({
    repo, providerFor: (_p: Platform) => new SpyProvider(),
    defaultEngine: "mock", enabledEngines: ["mock"],
  });

  const server = startAppServer({ repo, taskService, scheduleStore, scheduler }, 0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const port = (server.address() as AddressInfo).port;
  return { server, base: `http://127.0.0.1:${port}`, sent, scheduler, store: scheduleStore };
}

const body = {
  name: "nightly",
  platform: "github",
  repoFullName: "acme/demo",
  timeOfDay: "02:00",
  timezone: "Asia/Shanghai",
  delivery: { type: "feishu", webhookUrl: "https://open.feishu.cn/hook/x" },
};

test("schedules API: create, list, get, update, delete", async () => {
  const { server, base } = await start();
  try {
    assert.deepEqual(await (await fetch(`${base}/api/schedules`)).json(), []);

    const created = await (await fetch(`${base}/api/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })).json() as { id: string; enabled: boolean; branches: string[] };
    assert.ok(created.id);
    assert.equal(created.enabled, true);
    assert.deepEqual(created.branches, []);

    assert.equal((await (await fetch(`${base}/api/schedules`)).json() as unknown[]).length, 1);

    const got = await (await fetch(`${base}/api/schedules/${created.id}`)).json() as { name: string };
    assert.equal(got.name, "nightly");

    const updated = await (await fetch(`${base}/api/schedules/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false, branches: ["main", "dev"] }),
    })).json() as { enabled: boolean; branches: string[] };
    assert.equal(updated.enabled, false);
    assert.deepEqual(updated.branches, ["main", "dev"]);

    const del = await fetch(`${base}/api/schedules/${created.id}`, { method: "DELETE" });
    assert.equal(del.status, 204);
    assert.equal((await (await fetch(`${base}/api/schedules`)).json() as unknown[]).length, 0);
  } finally {
    server.close();
  }
});

test("schedules API: rejects a bad time; allows an omitted webhook (env fallback)", async () => {
  const { server, base } = await start();
  try {
    const badTime = await fetch(`${base}/api/schedules`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, timeOfDay: "25:99" }),
    });
    assert.equal(badTime.status, 400);

    // Omitting webhookUrl is allowed — delivery uses FEISHU_WEBHOOK_URL at send time.
    const noHook = await fetch(`${base}/api/schedules`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, delivery: { type: "feishu" } }),
    });
    assert.equal(noHook.status, 201);
    const created = await noHook.json() as { delivery: { webhookUrl: string } };
    assert.equal(created.delivery.webhookUrl, "");
  } finally {
    server.close();
  }
});

test("schedules API: POST /:id/run executes now and delivers", async () => {
  const { server, base, sent, scheduler } = await start();
  try {
    const created = await (await fetch(`${base}/api/schedules`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })).json() as { id: string };

    const run = await fetch(`${base}/api/schedules/${created.id}/run`, { method: "POST" });
    assert.equal(run.status, 200);
    const out = await run.json() as { ran: boolean; result: { totalFindings: number } };
    assert.equal(out.ran, true);
    assert.equal(out.result.totalFindings, 0);
    assert.equal(sent.length, 1); // delivered to Feishu
  } finally {
    scheduler.stop();
    server.close();
  }
});

test("schedules API: run is rejected (409) while the schedule is already running", async () => {
  const { server, base, store } = await start();
  try {
    const created = await (await fetch(`${base}/api/schedules`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })).json() as { id: string };
    // Simulate an in-flight run via the persisted running flag.
    await store.update(created.id, { running: true });
    const run = await fetch(`${base}/api/schedules/${created.id}/run`, { method: "POST" });
    assert.equal(run.status, 409);
  } finally {
    server.close();
  }
});
