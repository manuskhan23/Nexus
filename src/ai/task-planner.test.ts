import assert from "node:assert/strict";
import test from "node:test";
import { parseGeneratedPlan } from "./task-planner.js";

test("AI planner accepts a bounded JSON plan and fenced JSON", () => {
  const plan = parseGeneratedPlan(`\x60\x60\x60json
{"steps":[{"title":"Inspect code","description":"Review related modules.","dependencies":[]},{"title":"Implement","description":"Stage the change.","dependencies":[0]}]}
\x60\x60\x60`);
  assert.equal(plan.length, 2);
  assert.deepEqual(plan[1]?.dependencies, [0]);
});

test("AI planner rejects malformed, oversized, and cyclic plans", () => {
  assert.throws(() => parseGeneratedPlan("not json"), /invalid JSON/);
  assert.throws(() => parseGeneratedPlan(JSON.stringify({ steps: [] })), /between 1 and 20/);
  assert.throws(() => parseGeneratedPlan(JSON.stringify({ steps: [{ title: "A", description: "", dependencies: [1] }, { title: "B", description: "", dependencies: [0] }] })), /cycle/);
  assert.throws(() => parseGeneratedPlan(JSON.stringify({ steps: Array.from({ length: 21 }, (_, index) => ({ title: `Step ${index}`, description: "", dependencies: [] })) })), /between 1 and 20/);
});
