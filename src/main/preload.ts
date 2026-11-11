import { contextBridge, ipcRenderer } from "electron";

const projects = Object.freeze({
  choose: () => ipcRenderer.invoke("projects:choose"),
  list: () => ipcRenderer.invoke("projects:list"),
  scan: (id: string) => ipcRenderer.invoke("projects:scan", id),
  searchContext: (id: string, query: string) => ipcRenderer.invoke("projects:context", id, query),
  remove: (id: string) => ipcRenderer.invoke("projects:remove", id)
});

contextBridge.exposeInMainWorld("nexus", Object.freeze({ projects }));
