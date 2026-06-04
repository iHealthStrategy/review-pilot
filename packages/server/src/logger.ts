/**
 * Tiny structured logger. Emits one JSON object per line (ts/level/msg + extra
 * fields) to stdout, filtered by level — friendly to container log collectors
 * and zero-dependency. Replaces scattered `console.log` so a stateless
 * deployment has parseable, level-controlled logs.
 */
export type LogLevel = "error" | "warn" | "info" | "debug";

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export interface Logger {
  error(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(
  level: string,
  sink: (line: string) => void = (l) => process.stdout.write(l + "\n"),
): Logger {
  const threshold = ORDER[(level as LogLevel) in ORDER ? (level as LogLevel) : "info"];
  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] > threshold) return;
    sink(JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...fields }));
  };
  return {
    error: (m, f) => emit("error", m, f),
    warn: (m, f) => emit("warn", m, f),
    info: (m, f) => emit("info", m, f),
    debug: (m, f) => emit("debug", m, f),
  };
}
