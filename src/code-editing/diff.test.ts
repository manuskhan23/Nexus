import assert from "node:assert/strict";
import test from "node:test";
import { buildTextDiff } from "./diff.js";
import { normalizeEditPath, resolveProjectPath } from "./path-utils.js";

test("diff reports additions and removals while retaining duplicate lines", () => {
  const result = buildTextDiff("one\ntwo\ntwo", "one\nthree\ntwo");
  assert.deepEqual(result.lines, ["  one", "- two", "+ three", "  two"]);
  assert.equal(result.truncated, false);
});

test("diff bounds large inputs", () => {
  const result = buildTextDiff(Array(5).fill("a").join("\n"), "b", 3);
  assert.equal(result.truncated, true);
  assert.ok(result.lines.length <= 6);
});

test("edit paths normalize safe separators", () => {
  assert.equal(normalizeEditPath("src\\app.ts"), "src/app.ts");
});

test("edit paths reject traversal, absolute and secret paths", () => {
  for (const candidate of ["../outside.ts", "/outside.ts", "C:\\outside.ts", ".env", "keys/private.pem"]) {
    assert.throws(() => normalizeEditPath(candidate));
  }
});

test("resolved paths stay under the selected root", () => {
  assert.match(resolveProjectPath("/project", "src/app.ts"), /src[\\/]app\.ts$/);
});
