import { mkdtemp, rm } from "node:fs/promises";
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
  /** Shallow clone depth; 0 = full history. Structure review only needs a tree. */
  depth?: number;
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
    const dir = await mkdtemp(join(root, "reviewpilot-ws-"));
    const depth = this.options.depth ?? 1;
    const cloneArgs = ["clone"];
    if (depth > 0) cloneArgs.push("--depth", String(depth));
    cloneArgs.push(cloneUrl, dir);

    const cloned = await this.runner.run("git", cloneArgs);
    if (cloned.code !== 0) {
      throw new Error(`git clone failed: ${cloned.stderr}`);
    }
    // Fetch + checkout the exact head commit so the review sees the PR state.
    await this.runner.run("git", ["-C", dir, "fetch", "--depth", "1", "origin", ref]);
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
