import { randomUUID } from "node:crypto";
import { execFile, type ChildProcess } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { projectStore } from "../storage/project-store.js";

const execFileAsync = promisify(execFile);
const MAX_COMMAND_LENGTH = 16_000;
const MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_TIMEOUT_MS = 120_000;

export type ShellKind = "powershell" | "cmd";

export interface CommandRequest {
  projectId: string;
  command: string;
  shell: ShellKind;
  cwd?: string;
  timeoutMs?: number;
}

export interface CommandResult {
  processId: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  outputTruncated: boolean;
}

interface OwnedProcess {
  projectId: string;
  child: ChildProcess;
}

const owned = new Map<string, OwnedProcess>();

function boundedEnv(): NodeJS.ProcessEnv {
  const allowed = ["SystemRoot", "WINDIR", "PATH", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "COMSPEC"];
  return Object.fromEntries(allowed.flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : []));
}

async function resolveWorkingDirectory(projectRoot: string, requested?: string): Promise<string> {
  const root = await realpath(projectRoot);
  const candidate = path.resolve(root, requested || ".");
  const resolved = await realpath(candidate);
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new Error("Working directory must remain inside the registered project");
  }
  return resolved;
}

function terminateTree(child: ChildProcess): void {
  if (!child.pid || child.killed) return;
  if (process.platform === "win32") {
    const taskkill = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
    void execFileAsync(taskkill, ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }).catch(() => child.kill());
  } else {
    child.kill("SIGTERM");
  }
}

export async function runCommand(request: CommandRequest, approved: boolean): Promise<CommandResult> {
  if (!approved) throw new Error("Explicit approval is required to run terminal commands");
  if (process.platform !== "win32") throw new Error("Terminal execution is supported only on Windows");
  if (!request.projectId || request.projectId.length > 64) throw new Error("Invalid project identifier");
  if (typeof request.command !== "string" || !request.command.trim() || request.command.length > MAX_COMMAND_LENGTH) {
    throw new Error("Command must contain 1 to 16000 characters");
  }
  if (request.shell !== "powershell" && request.shell !== "cmd") throw new Error("Unsupported shell");
  const project = await projectStore.get(request.projectId);
  if (!project) throw new Error("Project not found");
  const cwd = await resolveWorkingDirectory(project.root, request.cwd);
  const timeoutMs = Math.max(1_000, Math.min(request.timeoutMs ?? 30_000, MAX_TIMEOUT_MS));
  const processId = randomUUID();
  const args = request.shell === "powershell"
    ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", request.command]
    : ["/d", "/s", "/c", request.command];
  const executable = request.shell === "powershell" ? "powershell.exe" : "cmd.exe";
  const child = execFile(executable, args, {
    cwd,
    env: boundedEnv(),
    windowsHide: true,
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: 0
  });
  owned.set(processId, { projectId: request.projectId, child });
  const started = Date.now();
  let timedOut = false;
  let outputTruncated = false;
  const timer = setTimeout(() => {
    timedOut = true;
    terminateTree(child);
  }, timeoutMs);
  try {
    return await new Promise<CommandResult>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let outputBytes = 0;
      const append = (target: "stdout" | "stderr", chunk: Buffer | string) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = MAX_OUTPUT_BYTES - outputBytes;
        if (remaining <= 0) {
          outputTruncated = true;
          terminateTree(child);
          return;
        }
        const bounded = value.subarray(0, remaining).toString("utf8");
        outputBytes += Math.min(value.length, remaining);
        if (value.length > remaining) outputTruncated = true;
        if (target === "stdout") stdout += bounded;
        else stderr += bounded;
      };
      child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
      child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
      child.once("error", reject);
      child.once("close", (code) => resolve({
        processId, exitCode: code, stdout, stderr, durationMs: Date.now() - started, timedOut, outputTruncated
      }));
    });
  } finally {
    clearTimeout(timer);
    owned.delete(processId);
  }
}

export async function cancelCommand(projectId: string, processId: string, approved: boolean): Promise<boolean> {
  if (!approved) throw new Error("Explicit approval is required to terminate a running process");
  const processRecord = owned.get(processId);
  if (!processRecord || processRecord.projectId !== projectId) return false;
  terminateTree(processRecord.child);
  return true;
}

export function listOwnedProcesses(projectId: string): string[] {
  return Array.from(owned.entries())
    .filter(([, processRecord]) => processRecord.projectId === projectId)
    .map(([id]) => id);
}
