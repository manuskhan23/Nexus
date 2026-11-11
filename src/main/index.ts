import { randomBytes } from "node:crypto";
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { startApiServer, type RunningApi } from "../server/runtime.js";

let windowRef: BrowserWindow | undefined;
let api: RunningApi | undefined;
const apiToken = randomBytes(32).toString("hex");

function assertTrustedRenderer(event: IpcMainInvokeEvent): void {
  const frame = event.senderFrame;
  if (!frame || frame !== windowRef?.webContents.mainFrame) throw new Error("Untrusted IPC sender");
  const url = new URL(frame.url);
  const isDevRenderer = !app.isPackaged && url.origin === "http://127.0.0.1:5173";
  const isPackagedRenderer = app.isPackaged && url.protocol === "file:";
  if (!isDevRenderer && !isPackagedRenderer) throw new Error("Untrusted IPC origin");
}

async function apiRequest<T>(route: string, init?: RequestInit): Promise<T> {
  if (!api) throw new Error("Project service is not ready");
  const response = await fetch(`http://127.0.0.1:${api.port}${route}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiToken}`,
      ...init?.headers
    }
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error || `Project service returned ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

function registerIpc(): void {
  ipcMain.handle("projects:choose", async (event) => {
    assertTrustedRenderer(event);
    const result = await dialog.showOpenDialog(windowRef!, {
      title: "Choose a project folder",
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return apiRequest("/api/projects", {
      method: "POST",
      body: JSON.stringify({ path: result.filePaths[0] })
    });
  });

  ipcMain.handle("projects:list", async (event) => {
    assertTrustedRenderer(event);
    return apiRequest("/api/projects");
  });

  ipcMain.handle("projects:scan", async (event, id: unknown) => {
    assertTrustedRenderer(event);
    if (typeof id !== "string" || id.length > 64) throw new Error("Invalid project identifier");
    return apiRequest(`/api/projects/${encodeURIComponent(id)}/scan`, { method: "POST" });
  });

  ipcMain.handle("projects:remove", async (event, id: unknown) => {
    assertTrustedRenderer(event);
    if (typeof id !== "string" || id.length > 64) throw new Error("Invalid project identifier");
    await apiRequest(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
    return true;
  });
}

async function createWindow(): Promise<void> {
  windowRef = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: "#000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  windowRef.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  windowRef.webContents.on("will-navigate", (event, target) => {
    const url = new URL(target);
    const allowed = app.isPackaged ? url.protocol === "file:" : url.origin === "http://127.0.0.1:5173";
    if (!allowed) event.preventDefault();
  });
  if (app.isPackaged) {
    await windowRef.loadFile(path.join(__dirname, "../renderer/index.html"));
  } else {
    await windowRef.loadURL("http://127.0.0.1:5173");
  }
  windowRef.on("closed", () => { windowRef = undefined; });
}

app.whenReady().then(async () => {
  api = await startApiServer(apiToken, 0);
  registerIpc();
  await createWindow();
}).catch((error: unknown) => {
  console.error(JSON.stringify({
    event: "desktop.start_failed",
    message: error instanceof Error ? error.message : "Application startup failed"
  }));
  app.quit();
});

let closing = false;
app.on("before-quit", (event) => {
  if (closing || !api) return;
  event.preventDefault();
  void api.close().finally(() => {
    closing = true;
    app.quit();
  });
});
