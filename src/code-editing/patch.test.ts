import assert from "node:assert/strict";
import test from "node:test";
import { applyTextPatches } from "./patch.js";

test("structured patches replace unique inspected context", () => {
  assert.equal(applyTextPatches("const value = 1;\n", [
    { expectedText: "const value = 1;", replacementText: "const value = 2;" }
  ]), "const value = 2;\n");
});

test("structured patches reject stale and ambiguous context", () => {
  assert.throws(() => applyTextPatches("alpha", [
    { expectedText: "beta", replacementText: "gamma" }
  ]), /no longer matches/);
  assert.throws(() => applyTextPatches("x+x", [
    { expectedText: "x", replacementText: "y" }
  ]), /ambiguous/);
});

test("structured patches enforce count and content limits", () => {
  assert.throws(() => applyTextPatches("", []), /between 1 and 100/);
  assert.throws(() => applyTextPatches("a", [
    { expectedText: "a", replacementText: "x".repeat(1_000_001) }
  ]), /1 MiB/);
});
