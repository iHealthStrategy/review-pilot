import type { DiffFile } from "../providers/git-provider.js";

/**
 * Parse a unified-diff patch into the set of NEW-side line numbers that the PR
 * adds. Used to restrict findings to the actual change (noise reduction).
 */
function addedLines(patch: string): Set<number> {
  const lines = new Set<number>();
  let cur = 0;
  for (const line of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      cur = Number.parseInt(header[1]!, 10);
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      lines.add(cur);
      cur++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      // removed line — does not advance the new-side counter
    } else if (!line.startsWith("\\")) {
      // context line (or blank) — advances the new-side counter
      cur++;
    }
  }
  return lines;
}

/** Map of file path → added line numbers, plus the set of changed file paths. */
export interface ChangedLines {
  byFile: Map<string, Set<number>>;
  files: Set<string>;
}

export function changedLines(diff: DiffFile[]): ChangedLines {
  const byFile = new Map<string, Set<number>>();
  const files = new Set<string>();
  for (const f of diff) {
    files.add(f.path);
    if (f.patch) byFile.set(f.path, addedLines(f.patch));
  }
  return { byFile, files };
}

/**
 * Keep only findings that concern the PR's actual change: a finding with a line
 * is kept when that line was added; a line-less finding is kept when its file
 * is part of the diff. Cuts noise from issues in untouched code.
 */
export function filterToChangedLines<
  T extends { filePath: string; line?: number },
>(findings: readonly T[], diff: DiffFile[]): T[] {
  const { byFile, files } = changedLines(diff);
  return findings.filter((f) => {
    if (f.line === undefined) return files.has(f.filePath);
    return byFile.get(f.filePath)?.has(f.line) ?? false;
  });
}
