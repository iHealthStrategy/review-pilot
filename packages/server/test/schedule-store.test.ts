import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileScheduleStore } from "../src/schedule/file-schedule-store.js";
import { ScheduleNotFoundError } from "../src/schedule/schedule.js";

function seqClock() {
  let t = Date.parse("2026-01-01T00:00:00.000Z");
  return () => {
    const iso = new Date(t).toISOString();
    t += 1000;
    return iso;
  };
}
function seqId() {
  let n = 0;
  return () => `sch_${++n}`;
}

const base = {
  name: "nightly",
  platform: "github" as const,
  repoFullName: "acme/demo",
  timeOfDay: "02:00",
  timezone: "Asia/Shanghai",
  delivery: { type: "feishu" as const, webhookUrl: "https://open.feishu.cn/hook/x" },
};

test("FileScheduleStore: create defaults + read back (in-memory)", async () => {
  const store = new FileScheduleStore({ clock: seqClock(), idGen: seqId() });
  await store.init();
  const c = await store.create(base);
  assert.equal(c.id, "sch_1");
  assert.equal(c.enabled, true);
  assert.deepEqual(c.branches, []); // empty = all branches
  assert.equal(c.cloneUrl, "https://github.com/acme/demo.git"); // derived
  assert.equal(c.timezone, "Asia/Shanghai");
  assert.equal(c.lookbackHours, 24); // default rolling window
  assert.deepEqual((await store.list()).map((s) => s.id), ["sch_1"]);
});

test("FileScheduleStore: update patches + clears engine, remove", async () => {
  const store = new FileScheduleStore({ clock: seqClock(), idGen: seqId() });
  await store.init();
  const c = await store.create({ ...base, engine: "claude-code", enabled: true });
  assert.equal(c.engine, "claude-code");

  const u = await store.update(c.id, { enabled: false, lastResult: "ok: 2 findings", engine: null });
  assert.equal(u.enabled, false);
  assert.equal(u.lastResult, "ok: 2 findings");
  assert.equal(u.engine, undefined); // cleared

  await store.remove(c.id);
  assert.equal((await store.list()).length, 0);
  await assert.rejects(store.remove(c.id), ScheduleNotFoundError);
});

test("FileScheduleStore: persists to a JSON file and reloads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rp-sch-"));
  const file = join(dir, "nested", "schedules.json");

  const a = new FileScheduleStore({ filePath: file, clock: seqClock(), idGen: seqId() });
  await a.init();
  await a.create(base);
  // File created (parent dir auto-made) and contains the config.
  const raw = JSON.parse(await readFile(file, "utf8"));
  assert.equal(raw.length, 1);
  assert.equal(raw[0].name, "nightly");

  // A fresh instance loads the persisted data.
  const b = new FileScheduleStore({ filePath: file });
  await b.init();
  assert.equal((await b.list()).length, 1);
  assert.equal((await b.list())[0]!.repoFullName, "acme/demo");
});
