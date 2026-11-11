import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isIgnoredPath, parseIgnoreRules } from "./ignore-rules.js";
import { scanProject } from "./scanner.js";
import { scanProjectFile } from "./scan-file.js";

test("ignore patterns support comments, negation, globs, and directory scope", () => {
  const rules = parseIgnoreRules("# comment\n*.log\n!important.log\n/src/**/generated?.ts\ncache/", "");
  assert.equal(isIgnoredPath("error.log", false, rules), true);
  assert.equal(isIgnoredPath("important.log", false, rules), false);
  assert.equal(isIgnoredPath("src/a/generated1.ts", false, rules), true);
  assert.equal(isIgnoredPath("src/a/keep.ts", false, rules), false);
  assert.equal(isIgnoredPath("cache/item.ts", false, rules), true);
});

test("nested ignore files are honored by full and incremental indexing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexus-scan-test-"));
  try {
    await mkdir(path.join(root, "src", "generated"), { recursive: true });
    await mkdir(path.join(root, "src", "local"), { recursive: true });
    await writeFile(path.join(root, ".gitignore"), "*.log\n!keep.log\n", "utf8");
    await writeFile(path.join(root, "keep.log"), "not indexed: unsupported type", "utf8");
    await writeFile(path.join(root, "drop.log"), "not indexed: unsupported type", "utf8");
    await writeFile(path.join(root, "src", ".gitignore"), "generated/\n", "utf8");
    await writeFile(path.join(root, "src", "generated", "hidden.ts"), "export const hidden = true;", "utf8");
    await writeFile(path.join(root, "src", "local", "visible.ts"), "export const visible = true;", "utf8");

    const scan = await scanProject(root);
    assert.deepEqual(scan.files.map((file) => file.path).sort(), ["src/local/visible.ts"]);
    assert.equal(await scanProjectFile(root, "src/generated/hidden.ts"), null);
    assert.equal((await scanProjectFile(root, "src/local/visible.ts"))?.path, "src/local/visible.ts");
    assert.equal(await readFile(path.join(root, "src/local/visible.ts"), "utf8"), "export const visible = true;");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ignore negation can re-include a file under a non-ignored parent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexus-negation-test-"));
  try {
    await mkdir(path.join(root, "output"), { recursive: true });
    await writeFile(path.join(root, ".gitignore"), "output/*\n!output/keep.ts\n", "utf8");
    await writeFile(path.join(root, "output", "keep.ts"), "export const kept = true;", "utf8");
    await writeFile(path.join(root, "output", "drop.ts"), "export const dropped = true;", "utf8");
    const scan = await scanProject(root);
    assert.deepEqual(scan.files.map((file) => file.path), ["output/keep.ts"]);
    assert.equal((await scanProjectFile(root, "output/keep.ts"))?.path, "output/keep.ts");
    assert.equal(await scanProjectFile(root, "output/drop.ts"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
