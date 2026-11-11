import assert from "node:assert/strict";
import test from "node:test";
import { runCommand } from "./process-manager.js";

test("terminal runner refuses execution unless explicitly approved", async () => {
  await assert.rejects(
    runCommand({ projectId: "project", command: "echo unsafe", shell: "cmd" }, false),
    /Explicit approval is required/
  );
});
