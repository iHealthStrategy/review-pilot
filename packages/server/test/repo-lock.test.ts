import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileRepoLock } from "../src/review/repo-lock.js";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "rp-lock-"));
}

test("grants the lock to one holder and denies a second until released", async () => {
  const dir = await tmp();
  const lockPath = join(dir, "r.lock");
  const lock = new FileRepoLock();

  const release = await lock.tryAcquire(lockPath);
  assert.ok(release, "first acquire should win");
  assert.equal(await lock.tryAcquire(lockPath), null, "second acquire should be denied");

  await release!();
  const again = await lock.tryAcquire(lockPath);
  assert.ok(again, "acquire should succeed after release");
  await again!();
});

test("steals a stale lock whose holder never released", async () => {
  const dir = await tmp();
  const lockPath = join(dir, "r.lock");
  // A lockfile stamped 20 minutes ago, with staleMs = 10 minutes.
  let clock = 1_000_000_000_000;
  await writeFile(lockPath, String(clock - 20 * 60 * 1000));
  const lock = new FileRepoLock({ staleMs: 10 * 60 * 1000, now: () => clock });

  const release = await lock.tryAcquire(lockPath);
  assert.ok(release, "a stale lock should be stolen");
  // We now own it; the stamp is current.
  assert.equal((await readFile(lockPath, "utf8")).trim(), String(clock));
  await release!();
});

test("does not steal a fresh lock held by someone else", async () => {
  const dir = await tmp();
  const lockPath = join(dir, "r.lock");
  let clock = 1_000_000_000_000;
  await writeFile(lockPath, String(clock - 1000)); // 1s ago — fresh
  const lock = new FileRepoLock({ staleMs: 10 * 60 * 1000, now: () => clock });
  assert.equal(await lock.tryAcquire(lockPath), null);
});

test("release is owner-checked: a stolen lock is not deleted by the prior owner", async () => {
  const dir = await tmp();
  const lockPath = join(dir, "r.lock");
  let clock = 1_000_000_000_000;
  const lock = new FileRepoLock({ staleMs: 10 * 60 * 1000, now: () => clock });

  const first = await lock.tryAcquire(lockPath);
  assert.ok(first);
  // Time jumps past staleMs; a new holder steals it.
  clock += 11 * 60 * 1000;
  const second = await lock.tryAcquire(lockPath);
  assert.ok(second, "stale lock should be steal-able");
  // The original owner releasing must NOT remove the new owner's lock.
  await first!();
  assert.equal(await lock.tryAcquire(lockPath), null, "second holder still owns it");
  await second!();
});
