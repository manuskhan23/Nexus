import type { ToolRegistry } from "../tools/tool-registry.js";
import { cancelCommand, listOwnedProcesses, runCommand } from "./process-manager.js";

function validateCommand(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Command input must be an object");
  const value = input as Record<string, unknown>;
  if (typeof value.projectId !== "string" || typeof value.command !== "string" ||
      (value.shell !== "powershell" && value.shell !== "cmd") ||
      (value.cwd !== undefined && typeof value.cwd !== "string") ||
      (value.timeoutMs !== undefined && typeof value.timeoutMs !== "number")) {
    throw new Error("Invalid terminal command request");
  }
  return {
    projectId: value.projectId,
    command: value.command,
    shell: value.shell,
    ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
    ...(typeof value.timeoutMs === "number" ? { timeoutMs: value.timeoutMs } : {})
  };
}

function validateProcess(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Process input must be an object");
  const value = input as Record<string, unknown>;
  if (typeof value.projectId !== "string" || typeof value.processId !== "string") {
    throw new Error("Project and process identifiers are required");
  }
  return { projectId: value.projectId, processId: value.processId };
}

export function registerTerminalTools(registry: ToolRegistry): void {
  registry.register({
    id: "terminal.run",
    name: "Run terminal command",
    description: "Run an explicitly approved PowerShell or CMD command inside a registered project",
    risk: "high",
    timeoutMs: 125_000,
    validate: validateCommand,
    execute: (input, context) => runCommand(input, context.approved)
  });
  registry.register({
    id: "terminal.cancel",
    name: "Stop terminal process",
    description: "Terminate a process owned by this project",
    risk: "high",
    timeoutMs: 5_000,
    validate: validateProcess,
    execute: (input, context) => cancelCommand(input.projectId, input.processId, context.approved)
  });
  registry.register({
    id: "terminal.list",
    name: "List project processes",
    description: "List process identifiers owned by this project",
    risk: "low",
    timeoutMs: 2_000,
    validate(input) {
      if (!input || typeof input !== "object" || Array.isArray(input) ||
          typeof (input as Record<string, unknown>).projectId !== "string") throw new Error("Project identifier is required");
      return { projectId: (input as Record<string, string>).projectId };
    },
    async execute(input) { return listOwnedProcesses(input.projectId); }
  });
}
