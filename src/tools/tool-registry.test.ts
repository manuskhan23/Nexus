import assert from "node:assert/strict";
import test from "node:test";
import { ToolApprovalRequiredError, ToolRegistry } from "./tool-registry.js";

test("registry validates inputs and records successful low-risk execution", async () => {
  const events: string[] = [];
  const registry = new ToolRegistry((event) => { events.push(event.status); });
  registry.register({
    id: "files.read",
    name: "Read file",
    description: "Read inspected project source",
    risk: "low",
    timeoutMs: 1000,
    validate(input) {
      if (!input || typeof input !== "object" || !("value" in input)) throw new Error("Invalid input");
      return input as { value: string };
    },
    async execute(input) { return input.value.toUpperCase(); }
  });
  const execution = await registry.execute<string>("files.read", { value: "ok" }, { projectId: "project", approved: false });
  assert.equal(execution.result, "OK");
  assert.deepEqual(events, ["started", "completed"]);
  assert.equal(registry.list().length, 1);
});

test("registry requires approval for medium and high risk tools", async () => {
  const registry = new ToolRegistry();
  registry.register({
    id: "files.apply",
    name: "Apply edits",
    description: "Write approved file changes",
    risk: "high",
    timeoutMs: 1000,
    validate: (input) => input,
    async execute() { return true; }
  });
  await assert.rejects(
    registry.execute("files.apply", {}, { projectId: "project", approved: false }),
    ToolApprovalRequiredError
  );
  const result = await registry.execute<boolean>("files.apply", {}, { projectId: "project", approved: true });
  assert.equal(result.result, true);
});

test("registry aborts timed out operations and rejects duplicate registrations", async () => {
  const registry = new ToolRegistry();
  const tool = {
    id: "slow.tool",
    name: "Slow tool",
    description: "Wait for a signal",
    risk: "low" as const,
    timeoutMs: 100,
    validate: (input: unknown) => input,
    execute: async (_input: unknown, context: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
    })
  };
  registry.register(tool);
  assert.throws(() => registry.register(tool), /already registered/);
  await assert.rejects(
    registry.execute("slow.tool", {}, { projectId: "project", approved: false }),
    /timed out/
  );
});
