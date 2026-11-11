import { contextBridge, ipcRenderer } from "electron";

const projects = Object.freeze({
  choose: () => ipcRenderer.invoke("projects:choose"),
  list: () => ipcRenderer.invoke("projects:list"),
  scan: (id: string) => ipcRenderer.invoke("projects:scan", id),
  searchContext: (id: string, query: string) => ipcRenderer.invoke("projects:context", id, query),
  remove: (id: string) => ipcRenderer.invoke("projects:remove", id)
});

const snapshots = Object.freeze({
  list: (projectId: string, filePath?: string) => ipcRenderer.invoke("snapshots:list", projectId, filePath),
  create: (projectId: string, filePath: string, reason?: string) =>
    ipcRenderer.invoke("snapshots:create", projectId, filePath, reason),
  diff: (projectId: string, snapshotId: string) => ipcRenderer.invoke("snapshots:diff", projectId, snapshotId),
  restore: (projectId: string, snapshotId: string, expectedCurrentHash: string | null) =>
    ipcRenderer.invoke("snapshots:restore", projectId, snapshotId, expectedCurrentHash)
});

const terminal = Object.freeze({
  run: (projectId: string, input: unknown, approvalGranted: boolean) =>
    ipcRenderer.invoke("terminal:run", projectId, input, approvalGranted),
  listProcesses: (projectId: string) => ipcRenderer.invoke("terminal:processes", projectId),
  getProcess: (projectId: string, processId: string) => ipcRenderer.invoke("terminal:get", projectId, processId),
  cancel: (projectId: string, processId: string, approvalGranted: boolean) =>
    ipcRenderer.invoke("terminal:cancel", projectId, processId, approvalGranted)
});

const settings = Object.freeze({
  listProviders: () => ipcRenderer.invoke("settings:providers"),
  saveProviderCredential: (provider: "gemini" | "groq", credential: string | null) =>
    ipcRenderer.invoke("settings:provider-credential", provider, credential),
  testProvider: (provider: "gemini" | "groq", model: string) =>
    ipcRenderer.invoke("settings:provider-test", provider, model)
});

const browser = Object.freeze({
  start: (projectId: string, approvalGranted: boolean) =>
    ipcRenderer.invoke("browser:start", projectId, approvalGranted),
  navigate: (projectId: string, sessionId: string, url: string, approvalGranted: boolean) =>
    ipcRenderer.invoke("browser:navigate", projectId, sessionId, url, approvalGranted),
  snapshot: (projectId: string, sessionId: string) =>
    ipcRenderer.invoke("browser:snapshot", projectId, sessionId),
  click: (projectId: string, sessionId: string, selector: string, approvalGranted: boolean) =>
    ipcRenderer.invoke("browser:click", projectId, sessionId, selector, approvalGranted),
  fill: (projectId: string, sessionId: string, selector: string, value: string, approvalGranted: boolean) =>
    ipcRenderer.invoke("browser:fill", projectId, sessionId, selector, value, approvalGranted),
  close: (projectId: string, sessionId: string, approvalGranted: boolean) =>
    ipcRenderer.invoke("browser:close", projectId, sessionId, approvalGranted)
});

const tasks = Object.freeze({
  list: (projectId: string) => ipcRenderer.invoke("tasks:list", projectId),
  create: (projectId: string, input: unknown) => ipcRenderer.invoke("tasks:create", projectId, input),
  setStatus: (projectId: string, taskId: string, status: string, note?: string) =>
    ipcRenderer.invoke("tasks:status", projectId, taskId, status, note),
  setStep: (projectId: string, taskId: string, stepId: string, status: string, result?: string) =>
    ipcRenderer.invoke("tasks:step", projectId, taskId, stepId, status, result)
});

const files = Object.freeze({
  read: (projectId: string, filePath: string) => ipcRenderer.invoke("files:read", projectId, filePath)
});

const edits = Object.freeze({
  list: (projectId: string) => ipcRenderer.invoke("edits:list", projectId),
  propose: (projectId: string, title: string, changes: unknown[]) =>
    ipcRenderer.invoke("edits:propose", projectId, title, changes),
  get: (projectId: string, proposalId: string) => ipcRenderer.invoke("edits:get", projectId, proposalId),
  apply: (projectId: string, proposalId: string, approvalGranted: boolean) =>
    ipcRenderer.invoke("edits:apply", projectId, proposalId, approvalGranted),
  reject: (projectId: string, proposalId: string) => ipcRenderer.invoke("edits:reject", projectId, proposalId)
});

contextBridge.exposeInMainWorld("nexus", Object.freeze({ projects, snapshots, files, edits, tasks, terminal, browser, settings }));
