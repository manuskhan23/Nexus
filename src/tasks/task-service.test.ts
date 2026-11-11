import assert from "node:assert/strict";
import test from "node:test";
import { canTransitionTask, redactSecrets, validateTaskPlan } from "./task-service.js";

test("task planner accepts an acyclic dependency graph", () => {
  assert.doesNotThrow(() => validateTaskPlan([
    { title: "Inspect", dependencies: [] },
    { title: "Implement", dependencies: [0] },
    { title: "Verify", dependencies: [1] }
  ]));
});

test("task planner rejects cyclic and out-of-range dependencies", () => {
  assert.throws(() => validateTaskPlan([
    { title: "A", dependencies: [1] },
    { title: "B", dependencies: [0] }
  ]), /cycle/i);
  assert.throws(() => validateTaskPlan([{ title: "A", dependencies: [2] }]), /dependencies/i);
});

test("terminal task states cannot resume", () => {
  assert.equal(canTransitionTask("completed", "running"), false);
  assert.equal(canTransitionTask("cancelled", "planning"), false);
  assert.equal(canTransitionTask("paused", "running"), true);
});

test("task logging redacts common credential formats", () => {
  assert.equal(redactSecrets("password=hunter2"), "password=[redacted]");
  assert.equal(redactSecrets("mongodb://user:pass@host/db"), "mongodb://[redacted]@");
});
