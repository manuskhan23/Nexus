import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { applyEditProposal, prepareEditProposal } from "./edit-service.js";
import { diffFileSnapshot, restoreFileSnapshot } from "../version-history/snapshot-service.js";
import { projectStore, type EditProposal, type FileSnapshot, type ProjectRecord } from "../storage/project-store.js";

const project: ProjectRecord = {
  id: "project-test",
  name: "test-project",
  root: "",
  addedAt: new Date().toISOString(),
  lastIndexedAt: null,
  indexVersion: 0
};

const original = {
  get: projectStore.get,
  createEditProposal: projectStore.createEditProposal,
  getEditProposal: projectStore.getEditProposal,
  claimEditProposal: projectStore.claimEditProposal,
  finishEditProposal: projectStore.finishEditProposal,
  addSnapshot: projectStore.addSnapshot,
  getSnapshot: projectStore.getSnapshot
};

let sandbox: string;
let snapshots: Map<string, FileSnapshot>;
let proposals: Map<string, EditProposal>;
let previousDataDir: string | undefined;

beforeEach(async () => {
  sandbox = await mkdtemp(path.join(os.tmpdir(), "nexus-edit-test-"));
  project.root = path.join(sandbox, "project");
  previousDataDir = process.env.NEXUS_DATA_DIR;
  process.env.NEXUS_DATA_DIR = path.join(sandbox, "data");
  await mkdir(path.join(project.root, "src"), { recursive: true });
  await writeFile(path.join(project.root, "src", "app.ts"), "export const value = 1;\n");
  snapshots = new Map();
  proposals = new Map();
  projectStore.get = async (id) => id === project.id ? project : undefined;
  projectStore.createEditProposal = async (proposal) => { proposals.set(proposal.id, proposal); };
  projectStore.getEditProposal = async (_projectId, id) => proposals.get(id);
  projectStore.claimEditProposal = async (_projectId, id) => {
    const proposal = proposals.get(id);
    if (!proposal || proposal.status !== "pending") return false;
    proposal.status = "applying";
    return true;
  };
  projectStore.finishEditProposal = async (_projectId, id, status, completedAt, failureMessage, snapshotIds) => {
    const proposal = proposals.get(id);
    if (!proposal) return;
    proposal.status = status;
    proposal.completedAt = completedAt;
    if (failureMessage) proposal.failureMessage = failureMessage;
    if (snapshotIds) proposal.snapshotIds = snapshotIds;
  };
  projectStore.addSnapshot = async (snapshot) => { snapshots.set(snapshot.id, snapshot); };
  projectStore.getSnapshot = async (_projectId, id) => snapshots.get(id);
});

afterEach(async () => {
  projectStore.get = original.get;
  projectStore.createEditProposal = original.createEditProposal;
  projectStore.getEditProposal = original.getEditProposal;
  projectStore.claimEditProposal = original.claimEditProposal;
  projectStore.finishEditProposal = original.finishEditProposal;
  projectStore.addSnapshot = original.addSnapshot;
  projectStore.getSnapshot = original.getSnapshot;
  if (previousDataDir === undefined) delete process.env.NEXUS_DATA_DIR;
  else process.env.NEXUS_DATA_DIR = previousDataDir;
  await rm(sandbox, { recursive: true, force: true });
});

test("approved edit applies atomically and snapshot restores original content", async () => {
  const filePath = path.join(project.root, "src", "app.ts");
  const originalText = await readFile(filePath, "utf8");
  const expectedHash = createHash("sha256").update(originalText).digest("hex");
  const proposal = await prepareEditProposal(project.id, "Update constant", [{
    path: "src/app.ts",
    action: "write",
    expectedHash,
    content: "export const value = 2;\n"
  }]);
  const applied = await applyEditProposal(project.id, proposal.id);
  assert.equal(await readFile(filePath, "utf8"), "export const value = 2;\n");
  assert.equal(applied.snapshotIds.length, 1);

  const comparison = await diffFileSnapshot(project.id, applied.snapshotIds[0]);
  await restoreFileSnapshot(project.id, applied.snapshotIds[0], comparison.currentHash);
  assert.equal(await readFile(filePath, "utf8"), originalText);
});

test("edit refuses to overwrite a file changed after inspection", async () => {
  const filePath = path.join(project.root, "src", "app.ts");
  const inspectedText = await readFile(filePath, "utf8");
  const proposal = await prepareEditProposal(project.id, "Update constant", [{
    path: "src/app.ts",
    action: "write",
    expectedHash: createHash("sha256").update(inspectedText).digest("hex"),
    content: "export const value = 2;\n"
  }]);
  await writeFile(filePath, "export const value = 3;\n");
  await assert.rejects(applyEditProposal(project.id, proposal.id), /changed since proposal review/);
  assert.equal(await readFile(filePath, "utf8"), "export const value = 3;\n");
});
