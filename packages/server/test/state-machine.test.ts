import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InvalidTransitionError,
  assertTransition,
  canTransition,
  isTerminal,
  nextStates,
} from "../src/domain/state-machine.js";

test("state-machine: legal transitions", () => {
  assert.ok(canTransition("pending", "running"));
  assert.ok(canTransition("pending", "failed"));
  assert.ok(canTransition("running", "succeeded"));
  assert.ok(canTransition("running", "failed"));
  assert.ok(canTransition("failed", "pending"));
});

test("state-machine: illegal transitions", () => {
  assert.equal(canTransition("succeeded", "running"), false);
  assert.equal(canTransition("succeeded", "pending"), false);
  assert.equal(canTransition("pending", "succeeded"), false);
  assert.equal(canTransition("failed", "running"), false);
});

test("state-machine: terminal & next states", () => {
  assert.ok(isTerminal("succeeded"));
  assert.equal(isTerminal("pending"), false);
  assert.deepEqual(nextStates("running"), ["succeeded", "failed"]);
  // defensive copy — mutating the result must not affect the machine.
  nextStates("running").push("pending");
  assert.deepEqual(nextStates("running"), ["succeeded", "failed"]);
});

test("state-machine: assertTransition throws typed error", () => {
  assert.throws(
    () => assertTransition("succeeded", "pending"),
    (err: unknown) => {
      assert.ok(err instanceof InvalidTransitionError);
      assert.equal(err.from, "succeeded");
      assert.equal(err.to, "pending");
      return true;
    },
  );
});
