import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertSafeCloneUrl,
  assertSafeGitArg,
  redactCreds,
} from "../src/review/git-safety.js";

test("assertSafeGitArg: rejects option-like refs/branches", () => {
  assert.equal(assertSafeGitArg("main", "ref"), "main");
  assert.equal(assertSafeGitArg("feature/x", "branch"), "feature/x");
  assert.throws(() => assertSafeGitArg("--upload-pack=cmd", "ref"), /unsafe ref/);
  assert.throws(() => assertSafeGitArg("-x", "branch"), /unsafe branch/);
  assert.throws(() => assertSafeGitArg("", "ref"), /non-empty/);
});

test("assertSafeCloneUrl: only http(s); blocks ext::/file/ssh/leading-dash", () => {
  assert.ok(assertSafeCloneUrl("https://x-access-token:tok@github.com/a/b.git"));
  assert.ok(assertSafeCloneUrl("http://gitlab.local/a/b.git"));
  for (const bad of ["ext::sh -c id", "file:///etc/passwd", "ssh://git@h/a/b", "git@h:a/b.git", "--upload-pack=cmd"]) {
    assert.throws(() => assertSafeCloneUrl(bad), /unsafe clone URL/, bad);
  }
});

test("redactCreds: masks inline user:token@ credentials", () => {
  assert.equal(
    redactCreds("git clone -- https://x-access-token:abc123@github.com/a/b.git"),
    "git clone -- https://***@github.com/a/b.git",
  );
  assert.equal(redactCreds("no creds here"), "no creds here");
});
