import assert from "node:assert/strict";
import { test } from "node:test";
import type { DiffFile } from "../src/providers/git-provider.js";
import { changedLines, filterToChangedLines } from "../src/review/diff-lines.js";

// A hunk that adds new lines 10 and 11 (context on 9 and 12).
const diff: DiffFile[] = [
  {
    path: "src/a.ts",
    status: "modified",
    patch: ["@@ -9,3 +9,4 @@", " const x = 1;", "+const y = 2;", "+const z = 3;", " const w = 4;"].join("\n"),
  },
  { path: "src/b.ts", status: "added" }, // no patch text
];

test("changedLines: extracts added line numbers from the patch", () => {
  const { byFile, files } = changedLines(diff);
  assert.deepEqual([...(byFile.get("src/a.ts") ?? [])], [10, 11]);
  assert.ok(files.has("src/a.ts"));
  assert.ok(files.has("src/b.ts"));
});

test("filterToChangedLines: keeps findings on added lines + file-level on changed files", () => {
  const findings = [
    { filePath: "src/a.ts", line: 10, severity: "major" as const }, // added → keep
    { filePath: "src/a.ts", line: 9, severity: "minor" as const }, // context → drop
    { filePath: "src/a.ts", severity: "info" as const }, // file-level on changed file → keep
    { filePath: "src/c.ts", line: 3, severity: "major" as const }, // untouched file → drop
  ];
  const kept = filterToChangedLines(findings, diff);
  assert.equal(kept.length, 2);
  assert.ok(kept.some((f) => f.line === 10));
  assert.ok(kept.some((f) => f.filePath === "src/a.ts" && f.line === undefined));
});
