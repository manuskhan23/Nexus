import { randomUUID, timingSafeEqual } from "node:crypto";
import { realpath } from "node:fs/promises";
import express from "express";
import path from "node:path";
import { searchProjectContext } from "../context/context-service.js";
import { scanProject } from "../project-intelligence/scanner.js";
import { watchProject, unwatchProject } from "../project-intelligence/watcher.js";
import { createFileSnapshot, diffFileSnapshot, restoreFileSnapshot } from "../version-history/snapshot-service.js";
import { projectStore } from "../storage/project-store.js";

export function createApiApp(apiToken: string): express.Express {
  if (apiToken.length < 32) throw new Error("API token must be at least 32 characters");

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));
  app.get("/health", (_request, response) => {
    response.json({ status: "ok", service: "nexus-api", phase: 4 });
  });

  app.use("/api", (request, response, next) => {
    const supplied = request.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    const expectedBytes = Buffer.from(apiToken);
    const suppliedBytes = Buffer.from(supplied);
    if (expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
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

  app.post("/api/projects/:id/context", async (request, response) => {
    const query: unknown = request.body?.query;
    if (typeof query !== "string") {
      response.status(400).json({ error: "A text query is required" });
      return;
    }
    try {
      response.json(await searchProjectContext(request.params.id, query));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Context search failed";
      const status = message === "Project not found" ? 404 : 400;
      response.status(status).json({ error: message });
    }
  });

  app.get("/api/projects/:id/snapshots", async (request, response) => {
    const project = await projectStore.get(request.params.id);
    if (!project) {
      response.status(404).json({ error: "Project not found" });
      return;
    }
    response.json({ snapshots: await projectStore.listSnapshots(project.id, request.query.path as string | undefined) });
  });

  app.post("/api/projects/:id/snapshots", async (request, response) => {
    const filePath: unknown = request.body?.path;
    const reason: unknown = request.body?.reason;
    if (typeof filePath !== "string" || filePath.length > 4096 ||
        (reason !== undefined && typeof reason !== "string")) {
      response.status(400).json({ error: "A valid project-relative path is required" });
      return;
    }
    try {
      response.status(201).json(await createFileSnapshot(request.params.id, filePath, reason as string | undefined));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Snapshot creation failed";
      const status = message === "Project not found" ? 404 : 400;
      response.status(status).json({ error: message });
    }
  });

  app.get("/api/projects/:id/snapshots/:snapshotId/diff", async (request, response) => {
    try {
      response.json(await diffFileSnapshot(request.params.id, request.params.snapshotId));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Snapshot diff failed";
      const status = message === "Project not found" || message === "Snapshot not found" ? 404 : 400;
      response.status(status).json({ error: message });
    }
  });

  app.post("/api/projects/:id/snapshots/:snapshotId/restore", async (request, response) => {
    const expectedCurrentHash: unknown = request.body?.expectedCurrentHash;
    if (expectedCurrentHash !== null &&
        (typeof expectedCurrentHash !== "string" || !/^[a-f0-9]{64}$/i.test(expectedCurrentHash))) {
      response.status(400).json({ error: "A current-file hash from the latest diff is required" });
      return;
    }
    try {
      response.json(await restoreFileSnapshot(
        request.params.id,
        request.params.snapshotId,
        expectedCurrentHash as string | null
      ));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Snapshot restore failed";
      const status = message === "Project not found" || message === "Snapshot not found" ? 404 : 409;
      response.status(status).json({ error: message });
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

  return app;
}
