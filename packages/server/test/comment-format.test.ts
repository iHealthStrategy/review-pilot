import assert from "node:assert/strict";
import { test } from "node:test";
import type { Finding } from "../src/domain/entities.js";
import { formatFindingsComment } from "../src/worker/comment-format.js";

function finding(over: Partial<Finding>): Finding {
  return {
    id: "f1",
    reviewJobId: "job1",
    filePath: "src/a.ts",
    severity: "major",
    title: "Issue",
    detail: "details",
    ...over,
  };
}

test("comment-format: empty findings renders a clean pass", () => {
  const body = formatFindingsComment([], { engine: "mock", prNumber: 7 });
  assert.match(body, /No issues found/);
  assert.match(body, /PR #7/);
});

test("comment-format: groups by severity with counts and suggestions", () => {
  const body = formatFindingsComment(
    [
      finding({ id: "a", severity: "critical", title: "Crash", line: 12 }),
      finding({ id: "b", severity: "minor", title: "Nit", suggestion: "rename" }),
    ],
    { engine: "claude-code", prNumber: 9 },
  );
  assert.match(body, /2 finding\(s\)/);
  assert.match(body, /Critical: 1/);
  assert.match(body, /Minor: 1/);
  assert.match(body, /src\/a\.ts:12/);
  assert.match(body, /💡 rename/);
  // Highest severity section comes first.
  assert.ok(body.indexOf("Crash") < body.indexOf("Nit"));
});
