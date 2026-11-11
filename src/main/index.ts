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

  ipcMain.handle("projects:context", async (event, id: unknown, query: unknown) => {
    assertTrustedRenderer(event);
    if (typeof id !== "string" || id.length > 64) throw new Error("Invalid project identifier");
    if (typeof query !== "string" || query.length > 512) throw new Error("Invalid context query");
    return apiRequest(`/api/projects/${encodeURIComponent(id)}/context`, {
      method: "POST",
      body: JSON.stringify({ query })
    });
  });

  ipcMain.handle("terminal:run", async (event, id: unknown, input: unknown, approvalGranted: unknown) => {
    assertTrustedRenderer(event);
    if (typeof id !== "string" || id.length > 64 || !input || typeof input !== "object" || approvalGranted !== true) {
      throw new Error("Explicit approval and a valid terminal command are required");
    }
    const value = input as Record<string, unknown>;
    if (typeof value.command !== "string" || value.command.length > 16_000 ||
        (value.shell !== "powershell" && value.shell !== "cmd") ||
        (value.cwd !== undefined && typeof value.cwd !== "string") ||
        (value.timeoutMs !== undefined && typeof value.timeoutMs !== "number")) {
      throw new Error("Invalid terminal command");
    }
    return apiRequest(`/api/projects/${encodeURIComponent(id)}/terminal/commands`, {
      method: "POST", body: JSON.stringify({ ...value, approved: true })
    });
  });

  ipcMain.handle("terminal:processes", async (event, id: unknown) => {
    assertTrustedRenderer(event);
    if (typeof id !== "string" || id.length > 64) throw new Error("Invalid project identifier");
    return apiRequest(`/api/projects/${encodeURIComponent(id)}/terminal/processes`);
  });

  ipcMain.handle("terminal:get", async (event, id: unknown, processId: unknown) => {
    assertTrustedRenderer(event);
    if (typeof id !== "string" || id.length > 64 || typeof processId !== "string" || processId.length > 64) {
      throw new Error("Invalid process reference");
    }
    return apiRequest(`/api/projects/${encodeURIComponent(id)}/terminal/processes/${encodeURIComponent(processId)}`);
  });

  ipcMain.handle("terminal:cancel", async (event, id: unknown, processId: unknown, approvalGranted: unknown) => {
    assertTrustedRenderer(event);
    if (typeof id !== "string" || id.length > 64 || typeof processId !== "string" || processId.length > 64 ||
        approvalGranted !== true) throw new Error("Explicit approval is required to stop the process");
    return apiRequest(`/api/projects/${encodeURIComponent(id)}/terminal/processes/${encodeURIComponent(processId)}/cancel`, {
      method: "POST", body: JSON.stringify({ approved: true })
    });
  });

  ipcMain.handle("tasks:list", async (event, id: unknown) => {
    assertTrustedRenderer(event);
    if (typeof id !== "string" || id.length > 64) throw new Error("Invalid project identifier");
    return apiRequest(`/api/projects/${encodeURIComponent(id)}/tasks`);
  });

  ipcMain.handle("tasks:create", async (event, id: unknown, input: unknown) => {
    assertTrustedRenderer(event);
    if (typeof id !== "string" || id.length > 64 || !input || typeof input !== "object") {
      throw new Error("Invalid task input");
    }
    return apiRequest(`/api/projects/${encodeURIComponent(id)}/tasks`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  });

  ipcMain.handle("tasks:status", async (event, id: unknown, taskId: unknown, status: unknown, note?: unknown) => {
    assertTrustedRenderer(event);
    if (typeof id !== "string" || id.length > 64 || typeof taskId !== "string" ||
        typeof status !== "string" || (note !== undefined && typeof note !== "string")) {
      throw new Error("Invalid task status update");
    }
    return apiRequest(`/api/projects/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}/status`, {
      method: "PUT",
      body: JSON.stringify({ status, note })
    });
  });

  ipcMain.handle("tasks:step", async (event, id: unknown, taskId: unknown, stepId: unknown, status: unknown, result?: unknown) => {
    assertTrustedRenderer(event);
    if (typeof id !== "string" || id.length > 64 || typeof taskId !== "string" ||
        typeof stepId !== "string" || typeof status !== "string" ||
        (result !== undefined && typeof result !== "string")) {
      throw new Error("Invalid task step update");
    }
    return apiRequest(`/api/projects/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}/steps/${encodeURIComponent(stepId)}`, {
      method: "PUT",
      body: JSON.stringify({ status, result })
    });
  });

  ipcMain.handle("browser:start", async (event, id: unknown, approvalGranted: unknown) => {
    assertTrustedRenderer(event);
    if (typeof id !== "string" || id.length > 64 || approvalGranted !== true) {
      throw new Error("Explicit approval and a valid project identifier are required");
    }
    return apiRequest(`/api/projects/${encodeURIComponent(id)}/browser/session`, {
      method: "POST", body: JSON.stringify({ approved: true })
    });
  });

  ipcMain.handle("browser:navigate", async (event, id: unknown, sessionId: unknown, url: unknown, approvalGranted: unknown) => {
    assertTrustedRenderer(event);
    if (typeof id !== "string" || id.length > 64 || typeof sessionId !== "string" ||
        sessionId.length > 64 || typeof url !== "string" || url.length > 4096 || approvalGranted !== true) {
      throw new Error("Explicit approval and valid browser navigation details are required");
    }
    return apiRequest(`/api/projects/${encodeURIComponent(id)}/browser/${encodeURIComponent(sessionId)}/navigate`, {
      method: "POST", body: JSON.stringify({ url, approved: true })
    });
  });

  ipcMain.handle("browser:snapshot", async (event, id: unknown, sessionId: unknown) => {
    assertTrustedRenderer(event);
    if (typeof id !== "string" || id.length > 64 || typeof sessionId !== "string" || sessionId.length > 64) {
      throw new Error("Invalid browser session reference");
    }
    return apiRequest(`/api/projects/${encodeURIComponent(id)}/browser/${encodeURIComponent(sessionId)}/snapshot`);
  });

  ipcMain.handle("browser:click", async (event, id: unknown, sessionId: unknown, selector: unknown, approvalGranted: unknown) => {
    assertTrustedRenderer(event);
    if (typeof id !== "string" || id.length > 64 || typeof sessionId !== "string" || sessionId.length > 64 ||
        typeof selector !== "string" || selector.length > 2000 || approvalGranted !== true) {
      throw new Error("Explicit approval and valid browser click details are required");
    }
    return apiRequest(`/api/projects/${encodeURIComponent(id)}/browser/${encodeURIComponent(sessionId)}/click`, {
      method: "POST", body: JSON.stringify({ selector, approved: true })
    });
  });

  ipcMain.handle("browser:fill", async (event, id: unknown, sessionId: unknown, selector: unknown, value: unknown, approvalGranted: unknown) => {
    assertTrustedRenderer(event);
    if (typeof id !== "string" || id.length > 64 || typeof sessionId !== "string" || sessionId.length > 64 ||
        typeof selector !== "string" || selector.length > 2000 || typeof value !== "string" || value.length > 2000 ||
        approvalGranted !== true) {
      throw new Error("Explicit approval and valid browser field details are required");
    }
    return apiRequest(`/api/projects/${encodeURIComponent(id)}/browser/${encodeURIComponent(sessionId)}/fill`, {
      method: "POST", body: JSON.stringify({ selector, value, approved: true })
    });
  });

  ipcMain.handle("browser:close", async (event, id: unknown, sessionId: unknown, approvalGranted: unknown) => {
    assertTrustedRenderer(event);
    if (typeof id !== "string" || id.length > 64 || typeof sessionId !== "string" || sessionId.length > 64 ||
        approvalGranted !== true) {
      throw new Error("Explicit approval and a valid browser session are required");
    }
    return apiRequest(`/api/projects/${encodeURIComponent(id)}/browser/${encodeURIComponent(sessionId)}/close`, {
      method: "POST", body: JSON.stringify({ approved: true })
    });
  });

  ipcMain.handle("files:read", async (event, id: unknown, filePath: unknown) => {
    assertTrustedRenderer(event);
    if (typeof id !== "string" || id.length > 64 || typeof filePath !== "string" || filePath.length > 4096) {
      throw new Error("Invalid project file reference");
    }
    return apiRequest(`/api/projects/${encodeURIComponent(id)}/files?path=${encodeURIComponent(filePath)}`);
  });

  ipcMain.handle("edits:list", async (event, id: unknown) => {
    assertTrustedRenderer(event);
    if (typeof id !== "string" || id.length > 64) throw new Error("Invalid project identifier");
    return apiRequest(`/api/projects/${encodeURIComponent(id)}/edit-proposals`);
  });

  ipcMain.handle("edits:propose", async (event, id: unknown, title: unknown, changes: unknown) => {
    assertTrustedRenderer(event);
    if (typeof id !== "string" || id.length > 64 || typeof title !== "string" || title.length > 160 ||
        !Array.isArray(changes) || changes.length === 0 || changes.length > 20) {
      throw new Error("Invalid edit proposal");
    }
    return apiRequest(`/api/projects/${encodeURIComponent(id)}/edit-proposals`, {
      method: "POST",
      body: JSON.stringify({ title, changes })
    });
  });

  ipcMain.handle("edits:get", async (event, id: unknown, proposalId: unknown) => {
    assertTrustedRenderer(event);
    if (typeof id !== "string" || id.length > 64 || typeof proposalId !== "string") {
      throw new Error("Invalid edit proposal reference");
    }
    return apiRequest(`/api/projects/${encodeURIComponent(id)}/edit-proposals/${encodeURIComponent(proposalId)}`);
  });

  ipcMain.handle("edits:apply", async (event, id: unknown, proposalId: unknown, approvalGranted: unknown) => {
    assertTrustedRenderer(event);
    if (typeof id !== "string" || id.length > 64 || typeof proposalId !== "string" || approvalGranted !== true) {
      throw new Error("Explicit approval is required to apply this edit proposal");
    }
    return apiRequest(`/api/projects/${encodeURIComponent(id)}/edit-proposals/${encodeURIComponent(proposalId)}/apply`, {
      method: "POST",
      body: JSON.stringify({ approved: true })
    });
  });

  ipcMain.handle("edits:reject", async (event, id: unknown, proposalId: unknown) => {
    assertTrustedRenderer(event);
    if (typeof id !== "string" || id.length > 64 || typeof proposalId !== "string") {
      throw new Error("Invalid edit proposal reference");
    }
    await apiRequest(`/api/projects/${encodeURIComponent(id)}/edit-proposals/${encodeURIComponent(proposalId)}/reject`, { method: "POST" });
    return true;
  });

  ipcMain.handle("snapshots:list", async (event, id: unknown, filePath?: unknown) => {
    assertTrustedRenderer(event);
    if (typeof id !== "string" || id.length > 64) throw new Error("Invalid project identifier");
    if (filePath !== undefined && (typeof filePath !== "string" || filePath.length > 4096)) {
      throw new Error("Invalid project file path");
    }
    const query = typeof filePath === "string" ? `?path=${encodeURIComponent(filePath)}` : "";
    return apiRequest(`/api/projects/${encodeURIComponent(id)}/snapshots${query}`);
  });

  ipcMain.handle("snapshots:create", async (event, id: unknown, filePath: unknown, reason?: unknown) => {
    assertTrustedRenderer(event);
    if (typeof id !== "string" || id.length > 64) throw new Error("Invalid project identifier");
    if (typeof filePath !== "string" || filePath.length > 4096) throw new Error("Invalid project file path");
    if (reason !== undefined && (typeof reason !== "string" || reason.length > 256)) throw new Error("Invalid snapshot reason");
    return apiRequest(`/api/projects/${encodeURIComponent(id)}/snapshots`, {
      method: "POST",
      body: JSON.stringify({ path: filePath, reason })
    });
  });

  ipcMain.handle("snapshots:diff", async (event, id: unknown, snapshotId: unknown) => {
    assertTrustedRenderer(event);
    if (typeof id !== "string" || typeof snapshotId !== "string") throw new Error("Invalid snapshot reference");
    return apiRequest(`/api/projects/${encodeURIComponent(id)}/snapshots/${encodeURIComponent(snapshotId)}/diff`);
  });

  ipcMain.handle("snapshots:restore", async (event, id: unknown, snapshotId: unknown, expectedHash: unknown) => {
    assertTrustedRenderer(event);
    if (typeof id !== "string" || typeof snapshotId !== "string") throw new Error("Invalid snapshot reference");
    if (expectedHash !== null && (typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/i.test(expectedHash))) {
      throw new Error("Refresh the snapshot comparison before restoring");
    }
    return apiRequest(`/api/projects/${encodeURIComponent(id)}/snapshots/${encodeURIComponent(snapshotId)}/restore`, {
      method: "POST",
      body: JSON.stringify({ expectedCurrentHash: expectedHash })
    });
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
  process.env.NEXUS_DATA_DIR = app.getPath("userData");
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
