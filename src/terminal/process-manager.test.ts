import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCommand } from "./process-manager.js";

test("terminal runner refuses execution unless explicitly approved", async () => {
  await assert.rejects(
    runCommand({ projectId: "project", command: "echo unsafe", shell: "cmd" }, false),
    /Explicit approval is required/
  );
});

test("PowerShell runs inside a registered project and captures output", {
  skip: process.platform !== "win32"
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexus-terminal-"));
  try {
    const result = await runCommand(
      { projectId: "test-project", command: "Write-Output 'nexus terminal smoke'", shell: "powershell" },
      true,
      async (id) => ({
        id, name: "test", root, addedAt: new Date().toISOString(), lastIndexedAt: null, indexVersion: 0
      })
    );
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /nexus terminal smoke/);
    assert.equal(result.timedOut, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("terminal runner kills a timed out PowerShell process tree", {
  skip: process.platform !== "win32"
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexus-terminal-timeout-"));
  try {
    const result = await runCommand(
      { projectId: "test-project", command: "Start-Sleep -Seconds 5", shell: "powershell", timeoutMs: 1_000 },
      true,
      async (id) => ({
        id, name: "test", root, addedAt: new Date().toISOString(), lastIndexedAt: null, indexVersion: 0
      })
    );
    assert.equal(result.timedOut, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
