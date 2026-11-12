import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
  assert.equal(isIgnoredPath("../outside.ts", false, rules), true);
  assert.equal(isIgnoredPath("/absolute.ts", false, rules), true);
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

test("incremental indexing refuses symlinks that escape the project", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexus-symlink-test-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "nexus-outside-test-"));
  try {
    await writeFile(path.join(outside, ".gitignore"), "*.ts\n", "utf8");
    await writeFile(path.join(outside, "visible.ts"), "export const secret = 'outside';", "utf8");
    try {
      await symlink(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (process.platform === "win32") {
        context.skip(`Symlink creation unavailable: ${error instanceof Error ? error.message : "unknown error"}`);
        return;
      }
      throw error;
    }
    assert.equal(await scanProjectFile(root, "linked/visible.ts"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("package manifest analysis ignores malformed dependency and script shapes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexus-package-test-"));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      name: "safe-project",
      dependencies: "not-an-object",
      devDependencies: { react: "^19.0.0" },
      scripts: ["not", "an", "object"]
    }), "utf8");
    await writeFile(path.join(root, "src.ts"), "export const app = true;", "utf8");
    const report = await scanProject(root);
    assert.equal(report.package?.name, "safe-project");
    assert.deepEqual(report.package?.dependencies, ["react"]);
    assert.deepEqual(report.package?.scripts, []);
    assert.deepEqual(report.package?.frameworks, ["react"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scanner does not follow a symlinked package manifest", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexus-manifest-link-test-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "nexus-manifest-outside-"));
  try {
    await writeFile(path.join(outside, "package.json"), JSON.stringify({ name: "outside-secret-project", dependencies: { secret: "1" } }), "utf8");
    try {
      await symlink(path.join(outside, "package.json"), path.join(root, "package.json"), process.platform === "win32" ? "file" : undefined);
    } catch (error) {
      if (process.platform === "win32") {
        context.skip(`Symlink creation unavailable: ${error instanceof Error ? error.message : "unknown error"}`);
        return;
      }
      throw error;
    }
    const report = await scanProject(root);
    assert.equal(report.package, null);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
