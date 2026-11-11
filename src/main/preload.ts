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

contextBridge.exposeInMainWorld("nexus", Object.freeze({ projects, snapshots }));
