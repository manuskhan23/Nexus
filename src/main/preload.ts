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
  apply: (projectId: string, proposalId: string) => ipcRenderer.invoke("edits:apply", projectId, proposalId),
  reject: (projectId: string, proposalId: string) => ipcRenderer.invoke("edits:reject", projectId, proposalId)
});

contextBridge.exposeInMainWorld("nexus", Object.freeze({ projects, snapshots, files, edits, tasks }));
