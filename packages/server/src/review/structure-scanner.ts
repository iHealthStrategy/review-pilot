import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const DEFAULT_IGNORES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".workspace",
]);

export interface ScanOptions {
  ignore?: Set<string>;
  /** Safety cap so a huge repo can't produce an unbounded structure list. */
  maxFiles?: number;
}

/**
 * Walk a synced workspace and return a sorted list of repo-relative file paths.
 * This is the "overall structure" signal that lets a review consider the whole
 * codebase rather than only the diff.
 */
export async function scanStructure(
  dir: string,
  options: ScanOptions = {},
): Promise<string[]> {
  const ignore = options.ignore ?? DEFAULT_IGNORES;
  const maxFiles = options.maxFiles ?? 5000;
  const out: string[] = [];

  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      if (ignore.has(entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.push(relative(dir, full));
      }
    }
  }

  await walk(dir);
  out.sort();
  return out;
}
