import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { bootstrap } from "../src/index.js";
import { NAME, VERSION } from "../src/version.js";

test("loadConfig: defaults run fully in mock mode with no credentials", () => {
  const cfg = loadConfig({});
  assert.equal(cfg.port, 3000);
  assert.equal(cfg.db.driver, "mock");
  assert.equal(cfg.review.defaultEngine, "mock");
  assert.deepEqual(cfg.review.enabledEngines, ["mock"]);
  assert.equal(cfg.trigger.pollIntervalSeconds, 0);
});

test("loadConfig: parses and validates overrides", () => {
  const cfg = loadConfig({
    PORT: "8080",
    DB_DRIVER: "sqlite",
    REVIEW_ENGINE: "claude-code",
    REVIEW_ENGINES_ENABLED: "claude-code, codex",
    POLL_INTERVAL_SECONDS: "30",
  });
  assert.equal(cfg.port, 8080);
  assert.equal(cfg.db.driver, "sqlite");
  assert.equal(cfg.review.defaultEngine, "claude-code");
  assert.deepEqual(cfg.review.enabledEngines, ["claude-code", "codex"]);
  assert.equal(cfg.trigger.pollIntervalSeconds, 30);
});

test("loadConfig: default engine is always included in enabled list", () => {
  const cfg = loadConfig({
    REVIEW_ENGINE: "codex",
    REVIEW_ENGINES_ENABLED: "mock",
  });
  assert.ok(cfg.review.enabledEngines.includes("codex"));
});

test("loadConfig: rejects invalid enum values", () => {
  assert.throws(() => loadConfig({ DB_DRIVER: "mysql" }), /Invalid DB_DRIVER/);
  assert.throws(
    () => loadConfig({ REVIEW_ENGINE: "bard" }),
    /Invalid REVIEW_ENGINE/,
  );
  assert.throws(() => loadConfig({ PORT: "abc" }), /Invalid integer for PORT/);
});

test("bootstrap: reports name/version/port", () => {
  const info = bootstrap({ PORT: "4100" });
  assert.equal(info.name, NAME);
  assert.equal(info.version, VERSION);
  assert.equal(info.port, 4100);
});
