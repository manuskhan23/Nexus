import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cancelCommand, getOwnedProcess, startCommand } from "./process-manager.js";

test("terminal runner refuses execution unless explicitly approved", async () => {
  await assert.rejects(
    startCommand({ projectId: "project", command: "echo unsafe", shell: "cmd" }, false),
    /Explicit approval is required/
  );
});

async function waitForProcess(projectId: string, processId: string) {
  const deadline = Date.now() + 10_000;
  let result = getOwnedProcess(projectId, processId);
  while (result?.status === "running" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    result = getOwnedProcess(projectId, processId);
  }
  assert.ok(result, "process state should be available");
  assert.notEqual(result.status, "running", `process should finish before the test deadline: ${JSON.stringify(result)}`);
  return result;
}

test("CMD runs inside a registered project and captures output", {
  skip: process.platform !== "win32"
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexus-terminal-"));
  let processId: string | undefined;
  try {
    const started = await startCommand(
      { projectId: "test-project", command: "echo nexus terminal smoke", shell: "cmd" },
      true,
      async (id) => ({
        id, name: "test", root, addedAt: new Date().toISOString(), lastIndexedAt: null, indexVersion: 0
      })
    );
    processId = started.processId;
    const result = await waitForProcess("test-project", started.processId);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /nexus terminal smoke/i);
    assert.equal(result.timedOut, false);
  } finally {
    if (processId) {
      await cancelCommand("test-project", processId, true);
      const deadline = Date.now() + 3_000;
      while (getOwnedProcess("test-project", processId)?.status === "running" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("PowerShell can exit normally", {
  skip: process.platform !== "win32"
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexus-terminal-powershell-"));
  let processId: string | undefined;
  try {
    const started = await startCommand(
      { projectId: "test-project", command: "exit 0", shell: "powershell", timeoutMs: 5_000 },
      true,
      async (id) => ({
        id, name: "test", root, addedAt: new Date().toISOString(), lastIndexedAt: null, indexVersion: 0
      })
    );
    processId = started.processId;
    const result = await waitForProcess("test-project", started.processId);
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.equal(result.status, "completed");
  } finally {
    if (processId) {
      await cancelCommand("test-project", processId, true);
      const deadline = Date.now() + 3_000;
      while (getOwnedProcess("test-project", processId)?.status === "running" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("PowerShell process timeout terminates the process tree", {
  skip: process.platform !== "win32"
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexus-terminal-timeout-"));
  let processId: string | undefined;
  try {
    const started = await startCommand(
      { projectId: "test-project", command: "Start-Sleep -Seconds 5", shell: "powershell", timeoutMs: 1_000 },
      true,
      async (id) => ({
        id, name: "test", root, addedAt: new Date().toISOString(), lastIndexedAt: null, indexVersion: 0
      })
    );
    processId = started.processId;
    const result = await waitForProcess("test-project", started.processId);
    assert.equal(result.timedOut, true);
    assert.equal(result.status, "failed");
  } finally {
    if (processId) {
      await cancelCommand("test-project", processId, true);
      const deadline = Date.now() + 3_000;
      while (getOwnedProcess("test-project", processId)?.status === "running" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});
