import { execFile } from "node:child_process";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Port for running external processes (git, review CLIs). Injected so the
 * cloner and external engines are testable without spawning real tools.
 */
export interface CommandRunOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Written to the child's stdin (then closed) — used to feed review prompts. */
  input?: string;
  /** Extra env vars merged over the parent env (e.g. TZ for date-bounded git). */
  env?: Record<string, string>;
}

export interface CommandRunner {
  run(
    command: string,
    args: string[],
    opts?: CommandRunOptions,
  ): Promise<CommandResult>;
}

/** Default {@link CommandRunner} backed by `child_process.execFile`. */
export class ProcessCommandRunner implements CommandRunner {
  run(
    command: string,
    args: string[],
    opts: CommandRunOptions = {},
  ): Promise<CommandResult> {
    return new Promise((resolve) => {
      const child = execFile(
        command,
        args,
        {
          cwd: opts.cwd,
          timeout: opts.timeoutMs ?? 0,
          maxBuffer: 64 * 1024 * 1024,
          ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
        },
        (err, stdout, stderr) => {
          const e = err as
            | (Error & { code?: unknown; killed?: boolean; signal?: string })
            | null;
          let code: number;
          if (e && typeof e.code === "number") code = e.code;
          else if (e && (e.killed || e.signal)) code = 124; // timeout/killed
          else if (e) code = 1;
          else code = 0;
          resolve({ code, stdout: stdout.toString(), stderr: stderr.toString() });
        },
      );
      if (opts.input !== undefined && child.stdin) {
        child.stdin.end(opts.input);
      }
    });
  }
}
