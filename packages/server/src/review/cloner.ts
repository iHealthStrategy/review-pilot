import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRunner } from "./command-runner.js";

/** A synced working copy of a repository at a specific ref. */
export interface Workspace {
  /** Absolute path to the checked-out full repository. */
  dir: string;
  ref: string;
}

/**
 * Port for syncing the FULL repository (not just the diff) so reviews can
 * reason about overall structure. Injected as a fake in tests.
 */
export interface Cloner {
  clone(cloneUrl: string, ref: string): Promise<Workspace>;
  cleanup(ws: Workspace): Promise<void>;
}

export interface GitClonerOptions {
  /** Root under which per-job working copies are created. */
  workspaceRoot?: string;
}

/**
 * Real {@link Cloner} that shells out to `git` via the {@link CommandRunner}
 * port. Unit-tested at the command-emission level (like SqlRepository); real
 * cloning is exercised in deployment, while logic tests use a fake cloner.
 */
export class GitCloner implements Cloner {
  constructor(
    private readonly runner: CommandRunner,
    private readonly options: GitClonerOptions = {},
  ) {}

  async clone(cloneUrl: string, ref: string): Promise<Workspace> {
    const root = this.options.workspaceRoot ?? tmpdir();
    // Ensure the workspace root exists (mkdtemp needs an existing parent).
    // recursive: true is idempotent, so concurrent jobs racing to create it
    // is safe; each then gets its own unique mkdtemp subdir below.
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(join(root, "reviewpilot-ws-"));

    // Full clone (all branches + history) so ANY commit reachable from a ref —
    // including a PR head on a non-default branch — can be checked out. A
    // shallow/single-branch clone only has the default branch tip, which made
    // `checkout <pr-head-sha>` fail with "unable to read tree". Blobs are
    // filtered out (--filter=blob:none) so this stays cheap on large repos:
    // git lazily fetches only the blobs the checkout/engine actually reads.
    const cloned = await this.runner.run("git", [
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      cloneUrl,
      dir,
    ]);
    if (cloned.code !== 0) {
      throw new Error(`git clone failed: ${cloned.stderr}`);
    }
    // Best-effort fetch of the exact commit (covers a head sha not yet pointed
    // at by a fetched ref); ignored if the server disallows by-sha fetch.
    await this.runner.run("git", ["-C", dir, "fetch", "origin", ref]);
    const checkout = await this.runner.run("git", ["-C", dir, "checkout", ref]);
    if (checkout.code !== 0) {
      throw new Error(`git checkout ${ref} failed: ${checkout.stderr}`);
    }
    return { dir, ref };
  }

  async cleanup(ws: Workspace): Promise<void> {
    await rm(ws.dir, { recursive: true, force: true });
  }
}
