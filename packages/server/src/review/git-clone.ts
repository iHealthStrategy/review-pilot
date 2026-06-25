import { mkdir, rm } from "node:fs/promises";
import type { CommandRunner } from "./command-runner.js";
import { assertSafeCloneUrl, redactCreds } from "./git-safety.js";

/**
 * Clone a repo (full history, no checkout) with retries. Repo egress to a Git
 * host can be intermittently flaky behind proxies/firewalls (transient
 * "SSL unexpected eof" / connect timeouts), and a one-shot clone fails the whole
 * review on the first blip. Retries up to `attempts` times, wiping the partial
 * working dir between tries (git refuses to clone into a non-empty dir).
 *
 * NOTE: a FULL clone (not `--filter=blob:none`) is deliberate. A blobless clone
 * defers blob downloads to checkout/diff time, fetching them lazily from the
 * promisor remote — and that mid-operation fetch is git-internal, so our retry
 * can't cover it; on a flaky network it fails with "could not fetch … from
 * promisor remote". Fetching everything up-front (inside the retried clone)
 * keeps all later checkout/diff steps purely local. Throws with the last
 * stderr if every attempt fails.
 */
export async function cloneWithRetry(
  runner: CommandRunner,
  cloneUrl: string,
  dir: string,
  attempts = 3,
): Promise<void> {
  assertSafeCloneUrl(cloneUrl);
  let lastErr = "";
  for (let i = 1; i <= attempts; i++) {
    // `--` ends option parsing so a URL/dir starting with `-` can't become a flag.
    const res = await runner.run("git", ["clone", "--no-checkout", "--", cloneUrl, dir]);
    if (res.code === 0) return;
    lastErr = res.stderr.trim();
    if (i < attempts) {
      // Clear the partial clone so the next attempt can write into an empty dir.
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
    }
  }
  throw new Error(`git clone failed after ${attempts} attempts: ${redactCreds(lastErr)}`);
}
