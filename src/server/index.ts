import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import express from "express";
import path from "node:path";
import { scanProject } from "../project-intelligence/scanner.js";
import { projectStore } from "../storage/project-store.js";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

app.get("/health", (_request, response) => {
  response.json({ status: "ok", service: "nexus-api", phase: 1 });
});

app.get("/api/projects", (_request, response) => {
  response.json({ projects: projectStore.list() });
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
      indexVersion: 1
    };
    projectStore.add(project);
    projectStore.saveIndex(project.id, scan.files, scan.scannedAt);
    response.status(201).json({ project, scan });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Project registration failed";
    const duplicate = message.includes("UNIQUE constraint failed");
    response.status(duplicate ? 409 : 400).json({ error: duplicate ? "Project is already registered" : message });
  }
});

app.post("/api/projects/:id/scan", async (request, response) => {
  const project = projectStore.get(request.params.id);
  if (!project) {
    response.status(404).json({ error: "Project not found" });
    return;
  }
  try {
    const scan = await scanProject(project.root);
    projectStore.saveIndex(project.id, scan.files, scan.scannedAt);
    response.json({ project: projectStore.get(project.id), scan });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Project scan failed";
    response.status(400).json({ error: message });
  }
});

app.delete("/api/projects/:id", (request, response) => {
  if (!projectStore.remove(request.params.id)) {
    response.status(404).json({ error: "Project not found" });
    return;
  }
  response.status(204).end();
});

const port = Number(process.env.NEXUS_API_PORT ?? 3001);
app.listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({ event: "server.started", port, host: "127.0.0.1" }));
});
