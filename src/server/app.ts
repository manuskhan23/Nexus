import { randomUUID, timingSafeEqual } from "node:crypto";
import { realpath } from "node:fs/promises";
import express from "express";
import path from "node:path";
import { searchProjectContext } from "../context/context-service.js";
import {
  applyEditProposal,
  getEditProposal,
  prepareEditProposal,
  readProjectFile,
  rejectEditProposal,
  type EditChangeInput
} from "../code-editing/edit-service.js";
import { scanProject } from "../project-intelligence/scanner.js";
import { watchProject, unwatchProject } from "../project-intelligence/watcher.js";
import { createFileSnapshot, diffFileSnapshot, restoreFileSnapshot } from "../version-history/snapshot-service.js";
import { projectStore } from "../storage/project-store.js";

export function createApiApp(apiToken: string): express.Express {
  if (apiToken.length < 32) throw new Error("API token must be at least 32 characters");

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "5mb" }));
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

  app.get("/api/projects/:id/files", async (request, response) => {
    const filePath = request.query.path;
    if (typeof filePath !== "string" || filePath.length > 4096) {
      response.status(400).json({ error: "A project-relative file path is required" });
      return;
    }
    try {
      response.json(await readProjectFile(request.params.id, filePath));
    } catch (error) {
      const message = error instanceof Error ? error.message : "File read failed";
      const status = message === "Project not found" ? 404 : 400;
      response.status(status).json({ error: message });
    }
  });

  app.get("/api/projects/:id/edit-proposals", async (request, response) => {
    const project = await projectStore.get(request.params.id);
    if (!project) {
      response.status(404).json({ error: "Project not found" });
      return;
    }
    const proposals = await projectStore.listEditProposals(project.id);
    response.json({
      proposals: proposals.map((proposal) => ({
        ...proposal,
        changes: proposal.changes.map(({ contentBlobKey: _blobKey, contentHash: _hash, ...change }) => change)
      }))
    });
  });

  app.post("/api/projects/:id/edit-proposals", async (request, response) => {
    const title: unknown = request.body?.title;
    const rawChanges: unknown = request.body?.changes;
    if (typeof title !== "string" || title.length > 160 || !Array.isArray(rawChanges) ||
        rawChanges.length === 0 || rawChanges.length > 20) {
      response.status(400).json({ error: "A title and between 1 and 20 changes are required" });
      return;
    }
    const changes: EditChangeInput[] = [];
    for (const raw of rawChanges) {
      if (!raw || typeof raw !== "object") {
        response.status(400).json({ error: "Each change must be an object" });
        return;
      }
      const change = raw as Record<string, unknown>;
      if (typeof change.path !== "string" || change.path.length > 4096 ||
          (change.action !== "write" && change.action !== "delete" && change.action !== "move") ||
          (change.action === "move" && (typeof change.destinationPath !== "string" || change.destinationPath.length > 4096)) ||
          (change.expectedHash !== null && typeof change.expectedHash !== "string") ||
          (change.content !== undefined && typeof change.content !== "string")) {
        response.status(400).json({ error: "Invalid file change" });
        return;
      }
      changes.push({
        path: change.path,
        action: change.action,
        expectedHash: change.expectedHash as string | null,
        ...(typeof change.destinationPath === "string" ? { destinationPath: change.destinationPath } : {}),
        ...(typeof change.content === "string" ? { content: change.content } : {})
      });
    }
    try {
      response.status(201).json(await prepareEditProposal(request.params.id, title, changes));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Edit proposal creation failed";
      const status = message === "Project not found" ? 404 :
        message.startsWith("File changed") ? 409 : 400;
      response.status(status).json({ error: message });
    }
  });

  app.get("/api/projects/:id/edit-proposals/:proposalId", async (request, response) => {
    try {
      response.json(await getEditProposal(request.params.id, request.params.proposalId));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Edit proposal lookup failed";
      const status = message === "Project not found" || message === "Edit proposal not found" ? 404 : 400;
      response.status(status).json({ error: message });
    }
  });

  app.post("/api/projects/:id/edit-proposals/:proposalId/apply", async (request, response) => {
    try {
      response.json(await applyEditProposal(request.params.id, request.params.proposalId));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Edit proposal could not be applied";
      const status = message === "Project not found" || message === "Edit proposal not found" ? 404 : 409;
      response.status(status).json({ error: message });
    }
  });

  app.post("/api/projects/:id/edit-proposals/:proposalId/reject", async (request, response) => {
    try {
      await rejectEditProposal(request.params.id, request.params.proposalId);
      response.status(204).end();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Edit proposal could not be rejected";
      const status = message === "Project not found" || message === "Edit proposal not found" ? 404 : 409;
      response.status(status).json({ error: message });
    }
  });

  app.get("/api/projects/:id/snapshots", async (request, response) => {
    const project = await projectStore.get(request.params.id);
    if (!project) {
      response.status(404).json({ error: "Project not found" });
      return;
    }
    const snapshots = await projectStore.listSnapshots(project.id, request.query.path as string | undefined);
    response.json({
      snapshots: snapshots.map(({ blobKey: _blobKey, ...snapshot }) => snapshot)
    });
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
