import { randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { projectStore, type ProjectRecord } from "../storage/project-store.js";

const execFileAsync = promisify(execFile);
const MAX_COMMAND_LENGTH = 16_000;
const MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_TIMEOUT_MS = 120_000;
const HISTORY_LIMIT = 100;
const HISTORY_TTL_MS = 10 * 60_000;

export type ShellKind = "powershell" | "cmd";

export interface CommandRequest {
  projectId: string;
  command: string;
  shell: ShellKind;
  cwd?: string;
  timeoutMs?: number;
}

export interface CommandSnapshot {
  processId: string;
  status: "running" | "completed" | "failed";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  outputTruncated: boolean;
}

interface OwnedProcess extends CommandSnapshot {
  projectId: string;
  child: ChildProcess;
  startedAtMs: number;
  timer: ReturnType<typeof setTimeout>;
}

const owned = new Map<string, OwnedProcess>();

function boundedEnv(): NodeJS.ProcessEnv {
  const allowed = ["SystemRoot", "WINDIR", "PATH", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "COMSPEC"];
  return Object.fromEntries(allowed.flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : []));
}

async function resolveWorkingDirectory(projectRoot: string, requested?: string): Promise<string> {
  const root = await realpath(projectRoot);
  const resolved = await realpath(path.resolve(root, requested || "."));
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

function pruneHistory(): void {
  const completed = Array.from(owned.entries())
    .filter(([, item]) => item.status !== "running")
    .sort((a, b) => a[1].startedAtMs - b[1].startedAtMs);
  const expired = completed.filter(([, item]) => Date.now() - item.startedAtMs > HISTORY_TTL_MS);
  for (const [id] of expired) owned.delete(id);
  const remaining = completed.filter(([id]) => owned.has(id));
  for (const [id] of remaining.slice(0, Math.max(0, remaining.length - HISTORY_LIMIT))) owned.delete(id);
}

export async function startCommand(
  request: CommandRequest,
  approved: boolean,
  getProject: (projectId: string) => Promise<ProjectRecord | undefined> = projectStore.get
): Promise<{ processId: string }> {
  if (!approved) throw new Error("Explicit approval is required to run terminal commands");
  if (process.platform !== "win32") throw new Error("Terminal execution is supported only on Windows");
  if (!request.projectId || request.projectId.length > 64) throw new Error("Invalid project identifier");
  if (typeof request.command !== "string" || !request.command.trim() || request.command.length > MAX_COMMAND_LENGTH) {
    throw new Error("Command must contain 1 to 16000 characters");
  }
  if (request.shell !== "powershell" && request.shell !== "cmd") throw new Error("Unsupported shell");
  const project = await getProject(request.projectId);
  if (!project) throw new Error("Project not found");
  const cwd = await resolveWorkingDirectory(project.root, request.cwd);
  const timeoutMs = Math.max(1_000, Math.min(request.timeoutMs ?? 30_000, MAX_TIMEOUT_MS));
  const processId = randomUUID();
  const args = request.shell === "powershell"
    ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(request.command + "\nif ($null -eq $LASTEXITCODE) { exit 0 } else { exit $LASTEXITCODE }", "utf16le").toString("base64")]
    : ["/d", "/s", "/c", request.command];
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const executable = request.shell === "powershell"
    ? path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : path.join(systemRoot, "System32", "cmd.exe");
  const child = spawn(executable, args, {
    cwd, env: boundedEnv(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
  });
  const startedAtMs = Date.now();
  const item: OwnedProcess = {
    projectId: request.projectId,
    child,
    processId,
    status: "running",
    exitCode: null,
    stdout: "",
    stderr: "",
    durationMs: 0,
    timedOut: false,
    outputTruncated: false,
    startedAtMs,
    timer: setTimeout(() => {
      item.timedOut = true;
      terminateTree(child);
    }, timeoutMs)
  };
  owned.set(processId, item);
  const append = (target: "stdout" | "stderr", chunk: Buffer | string) => {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const used = Buffer.byteLength(item.stdout) + Buffer.byteLength(item.stderr);
    const remaining = MAX_OUTPUT_BYTES - used;
    if (remaining <= 0) {
      item.outputTruncated = true;
      terminateTree(child);
      return;
    }
    const bounded = value.subarray(0, remaining).toString("utf8");
    if (target === "stdout") item.stdout += bounded;
    else item.stderr += bounded;
    if (value.length > remaining) {
      item.outputTruncated = true;
      terminateTree(child);
    }
  };
  child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
  child.once("error", (error) => {
    item.status = "failed";
    item.stderr = (item.stderr + "\n" + error.message).slice(0, MAX_OUTPUT_BYTES);
    item.durationMs = Date.now() - startedAtMs;
    clearTimeout(item.timer);
    pruneHistory();
  });
  const markExited = (code: number | null) => {
    item.status = code === 0 && !item.timedOut ? "completed" : "failed";
    item.exitCode = code;
    item.durationMs = Date.now() - startedAtMs;
    clearTimeout(item.timer);
    pruneHistory();
  };
  child.once("exit", (code) => markExited(code));
  child.once("close", (code) => markExited(code));
  pruneHistory();
  return { processId };
}

function publicSnapshot(item: OwnedProcess): CommandSnapshot {
  return {
    processId: item.processId,
    status: item.status,
    exitCode: item.exitCode,
    stdout: item.stdout,
    stderr: item.stderr,
    durationMs: item.status === "running" ? Date.now() - item.startedAtMs : item.durationMs,
    timedOut: item.timedOut,
    outputTruncated: item.outputTruncated
  };
}

export function getOwnedProcess(projectId: string, processId: string): CommandSnapshot | undefined {
  const item = owned.get(processId);
  return item?.projectId === projectId ? publicSnapshot(item) : undefined;
}

export async function cancelCommand(projectId: string, processId: string, approved: boolean): Promise<boolean> {
  if (!approved) throw new Error("Explicit approval is required to terminate a running process");
  const item = owned.get(processId);
  if (!item || item.projectId !== projectId || item.status !== "running") return false;
  terminateTree(item.child);
  return true;
}

export function listOwnedProcesses(projectId: string): CommandSnapshot[] {
  pruneHistory();
  return Array.from(owned.values())
    .filter((item) => item.projectId === projectId && item.status === "running")
    .map(publicSnapshot);
}
