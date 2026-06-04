import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryRepository } from "../src/persistence/memory-repository.js";
import { uuidIdGen } from "../src/persistence/repository.js";

// Regression: the default id generator must not rely on a global `crypto`
// (absent on Node 18). Tests inject a deterministic id-gen, so this path was
// previously unexercised and failed only at runtime.
test("uuidIdGen produces prefixed unique ids without global crypto", () => {
  const a = uuidIdGen("prj");
  const b = uuidIdGen("prj");
  assert.match(a, /^prj_[0-9a-f-]{36}$/);
  assert.notEqual(a, b);
});

test("MemoryRepository works with default (uuid) id generator", async () => {
  const repo = new MemoryRepository(); // no injected idGen/clock
  await repo.init();
  const project = await repo.createProject({
    name: "default-ids",
    platform: "github",
    defaultEngine: "mock",
    enabledEngines: ["mock"],
  });
  assert.match(project.id, /^prj_/);
  const fetched = await repo.getProject(project.id);
  assert.equal(fetched?.id, project.id);
});
