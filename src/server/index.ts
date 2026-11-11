import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import express from "express";
import path from "node:path";
import { scanProject } from "../project-intelligence/scanner.js";
import { stopProjectWatchers, unwatchProject, watchProject, watchProjects } from "../project-intelligence/watcher.js";
import { projectStore } from "../storage/project-store.js";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

app.get("/health", (_request, response) => {
  response.json({ status: "ok", service: "nexus-api", phase: 1 });
});

app.get("/api/projects", async (_request, response) => {
  response.json({ projects: await projectStore.list() });
});

app.post("/api/projects", async (request, response) => {
  const requestedPath: unknown = request.body?.path;
  if (typeof requestedPath !== "string" || requestedPath.trim().length === 0 || requestedPath.length > 4096) {
    response.status(400).json({ error: "A valid project path is required" });
    return;
  }
  try {
    const root = await realpath(requestedPath);
    const scan = await scanProject(root);
    const project = {
      id: randomUUID(),
      name: scan.package?.name || path.basename(root),
      root,
      addedAt: new Date().toISOString(),
      lastIndexedAt: scan.scannedAt,
      indexVersion: 0
    };
    await projectStore.add(project);
    await projectStore.saveIndex(project.id, scan.files, scan.scannedAt);
    const storedProject = await projectStore.get(project.id);
    if (storedProject) watchProject(storedProject);
    response.status(201).json({ project: storedProject, scan });
  } catch (error) {
    const mongoCode = typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: number }).code : undefined;
    const duplicate = mongoCode === 11000;
    const message = error instanceof Error ? error.message : "Project registration failed";
    response.status(duplicate ? 409 : 400).json({
      error: duplicate ? "Project is already registered" : message
    });
  }
});

app.post("/api/projects/:id/scan", async (request, response) => {
  const project = await projectStore.get(request.params.id);
  if (!project) {
    response.status(404).json({ error: "Project not found" });
    return;
  }
  try {
    const scan = await scanProject(project.root);
    await projectStore.saveIndex(project.id, scan.files, scan.scannedAt);
    response.json({ project: await projectStore.get(project.id), scan });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Project scan failed";
    response.status(400).json({ error: message });
  }
});

app.delete("/api/projects/:id", async (request, response) => {
  if (!await projectStore.remove(request.params.id)) {
    response.status(404).json({ error: "Project not found" });
    return;
  }
  unwatchProject(request.params.id);
  response.status(204).end();
});

const port = Number(process.env.NEXUS_API_PORT ?? 3001);
let server: ReturnType<typeof app.listen> | undefined;

async function start(): Promise<void> {
  const projects = await projectStore.list();
  watchProjects(projects);
  server = app.listen(port, "127.0.0.1", () => {
    console.log(JSON.stringify({ event: "server.started", port, host: "127.0.0.1" }));
  });
}

async function shutdown(): Promise<void> {
  stopProjectWatchers();
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  await projectStore.close();
}

process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });

start().catch((error: unknown) => {
  console.error(JSON.stringify({
    event: "server.start_failed",
    message: error instanceof Error ? error.message : "Database connection failed"
  }));
  process.exitCode = 1;
});
