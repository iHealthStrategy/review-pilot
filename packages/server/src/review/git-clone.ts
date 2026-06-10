import { mkdir, rm } from "node:fs/promises";
import type { CommandRunner } from "./command-runner.js";

/**
 * Clone a repo (blobless, no checkout) with retries. Repo egress to a Git host
 * can be intermittently flaky behind proxies/firewalls (transient
 * "SSL unexpected eof" / connect timeouts), and a one-shot clone fails the whole
 * review on the first blip. Retries up to `attempts` times, wiping the partial
 * working dir between tries (git refuses to clone into a non-empty dir).
 * Throws with the last stderr if every attempt fails.
 */
export async function cloneBloblessWithRetry(
  runner: CommandRunner,
  cloneUrl: string,
  dir: string,
  attempts = 3,
): Promise<void> {
  let lastErr = "";
  for (let i = 1; i <= attempts; i++) {
    const res = await runner.run("git", [
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      cloneUrl,
      dir,
    ]);
    if (res.code === 0) return;
    lastErr = res.stderr.trim();
    if (i < attempts) {
      // Clear the partial clone so the next attempt can write into an empty dir.
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
    }
  }
  throw new Error(`git clone failed after ${attempts} attempts: ${lastErr}`);
}
