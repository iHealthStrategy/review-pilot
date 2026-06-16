import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";

/** Released by calling the returned function; safe to call more than once. */
export type LockRelease = () => Promise<void>;

/**
 * Cross-process mutual exclusion keyed by an arbitrary path. `tryAcquire`
 * NEVER blocks: it returns a release handle to the single winner, or null when
 * the lock is already held. This is deliberately non-blocking so a burst of
 * concurrent reviews on one repo doesn't queue — losers fall back to the
 * existing (possibly stale) graph or skip structural context entirely.
 */
export interface RepoLock {
  tryAcquire(lockPath: string): Promise<LockRelease | null>;
}

export interface FileRepoLockOptions {
  /** A held lock older than this is presumed abandoned and stolen (ms). */
  staleMs?: number;
  /** Clock (injectable for tests). */
  now?: () => number;
}

/**
 * {@link RepoLock} backed by atomic `O_EXCL` lockfile creation — correct across
 * processes on a shared local filesystem (the recommended per-host cache
 * layout). A crashed holder is recovered via a staleness timeout. NOTE: `O_EXCL`
 * is not reliable over NFS; for a cache volume shared across hosts use a
 * database advisory lock instead (e.g. Postgres `pg_advisory_lock`).
 */
export class FileRepoLock implements RepoLock {
  private readonly staleMs: number;
  private readonly now: () => number;

  constructor(options: FileRepoLockOptions = {}) {
    this.staleMs = options.staleMs ?? 10 * 60 * 1000; // 10 min
    this.now = options.now ?? Date.now;
  }

  async tryAcquire(lockPath: string): Promise<LockRelease | null> {
    await mkdir(dirname(lockPath), { recursive: true });
    const stamp = String(this.now());
    if (await this.create(lockPath, stamp)) return this.releaser(lockPath, stamp);

    // Held — steal only if the existing stamp is older than staleMs.
    const existing = await readFile(lockPath, "utf8").catch(() => "");
    const ts = Number.parseInt(existing.trim(), 10);
    if (!Number.isFinite(ts) || this.now() - ts <= this.staleMs) return null;

    await rm(lockPath, { force: true });
    const fresh = String(this.now());
    return (await this.create(lockPath, fresh)) ? this.releaser(lockPath, fresh) : null;
  }

  /** Atomically create the lockfile; false if it already exists. */
  private async create(lockPath: string, stamp: string): Promise<boolean> {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(stamp);
      await handle.close();
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
  }

  /** Release only if WE still own the lock (stamp matches) — avoids deleting a stolen one. */
  private releaser(lockPath: string, stamp: string): LockRelease {
    return async () => {
      const current = await readFile(lockPath, "utf8").catch(() => null);
      if (current !== null && current.trim() === stamp) {
        await rm(lockPath, { force: true });
      }
    };
  }
}
