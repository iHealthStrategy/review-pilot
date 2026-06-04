import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Cloner, Workspace } from "../src/review/cloner.js";
import type {
  CommandResult,
  CommandRunner,
  CommandRunOptions,
} from "../src/review/command-runner.js";

/**
 * {@link Cloner} fake that materialises a REAL temp workspace from an in-memory
 * file map, so structure scanning runs against actual files with no network.
 */
export class FakeCloner implements Cloner {
  cloneCalls: { cloneUrl: string; ref: string }[] = [];
  cleanups = 0;

  constructor(private readonly files: Record<string, string>) {}

  async clone(cloneUrl: string, ref: string): Promise<Workspace> {
    this.cloneCalls.push({ cloneUrl, ref });
    const dir = await mkdtemp(join(tmpdir(), "reviewpilot-fakews-"));
    for (const [rel, content] of Object.entries(this.files)) {
      const full = join(dir, rel);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content, "utf8");
    }
    return { dir, ref };
  }

  async cleanup(ws: Workspace): Promise<void> {
    this.cleanups += 1;
    await rm(ws.dir, { recursive: true, force: true });
  }
}

/** Recording {@link CommandRunner} with canned, FIFO results. */
export class FakeCommandRunner implements CommandRunner {
  calls: { command: string; args: string[]; cwd?: string; input?: string }[] = [];
  private readonly results: CommandResult[];

  constructor(results: CommandResult[] = []) {
    this.results = [...results];
  }

  async run(
    command: string,
    args: string[],
    opts: CommandRunOptions = {},
  ): Promise<CommandResult> {
    this.calls.push({ command, args, cwd: opts.cwd, input: opts.input });
    return this.results.shift() ?? { code: 0, stdout: "", stderr: "" };
  }
}
