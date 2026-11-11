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
    { expectedText: "a", replacementText: "x".repeat(20_001) }
  ]), /Invalid structured patch/);

  const original = Array.from({ length: 60 }, (_, index) => `placeholder-${index}`).join("\\n");
  const patches = Array.from({ length: 60 }, (_, index) => ({
    expectedText: `placeholder-${index}`,
    replacementText: "x".repeat(20_000)
  }));
  assert.throws(() => applyTextPatches(original, patches), /1 MiB/);
});
