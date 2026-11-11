import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FileSnapshot, ProjectRecord } from "../storage/project-store.js";
import { projectStore } from "../storage/project-store.js";

const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
const SECRET_PATH = /(^|\/)(\.env(?:\.|$)|.*\.(?:pem|key|p12|pfx)$|credentials?\.|secrets?\.)/i;
const SNAPSHOT_ID = /^[0-9a-f-]{36}$/i;

export interface SnapshotDiff {
  snapshot: Omit<FileSnapshot, "blobKey">;
  currentHash: string | null;
  currentExists: boolean;
  added: string[];
  removed: string[];
  truncated: boolean;
}

function normalizeRelativePath(input: string): string {
  const normalized = input.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[a-z]:/i.test(normalized) ||
      normalized.split("/").some((part) => part === ".." || part === "." || part === "")) {
    throw new Error("File path must be a normalized path inside the project");
  }
  if (SECRET_PATH.test(normalized)) throw new Error("Secret and credential files cannot be snapshotted");
  return normalized;
}

async function getProjectFile(project: ProjectRecord, relativePath: string): Promise<{ absolute: string; bytes: Buffer; mode: number } | null> {
  const root = await realpath(project.root);
  const normalized = normalizeRelativePath(relativePath);
  const absolute = path.resolve(root, normalized);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("File path is outside the project");
  }
  try {
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Only regular project files can be snapshotted");
    if (info.size > MAX_SNAPSHOT_BYTES) throw new Error("File is too large to snapshot");
    const actualPath = await realpath(absolute);
    const actualRelative = path.relative(root, actualPath);
    if (!actualRelative || actualRelative.startsWith("..") || path.isAbsolute(actualRelative)) {
      throw new Error("File resolves outside the project");
    }
    const bytes = await readFile(actualPath);
    if (bytes.length > MAX_SNAPSHOT_BYTES) throw new Error("File grew beyond the snapshot size limit");
    if (bytes.includes(0)) throw new Error("Binary files cannot be snapshotted");
    return { absolute, bytes, mode: info.mode & 0o777 };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function snapshotDirectory(): Promise<string> {
  const directory = path.join(process.env.NEXUS_DATA_DIR || path.join(os.homedir(), ".nexus-ai"), "snapshots");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

async function saveBytes(projectId: string, relativePath: string, bytes: Buffer, mode: number, reason: string): Promise<FileSnapshot> {
  const id = randomUUID();
  const blobKey = `${id}.snapshot`;
  const directory = await snapshotDirectory();
  const finalPath = path.join(directory, blobKey);
  const temporaryPath = path.join(directory, `${id}.tmp`);
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, finalPath);
  const snapshot: FileSnapshot = {
    id,
    projectId,
    path: relativePath,
    contentHash: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    mode,
    createdAt: new Date().toISOString(),
    reason: reason.slice(0, 256),
    blobKey
  };
  await projectStore.addSnapshot(snapshot);
  return snapshot;
}

async function readSnapshot(snapshot: FileSnapshot): Promise<Buffer> {
  if (!SNAPSHOT_ID.test(snapshot.id) || snapshot.blobKey !== `${snapshot.id}.snapshot`) {
    throw new Error("Invalid snapshot reference");
  }
  const bytes = await readFile(path.join(await snapshotDirectory(), snapshot.blobKey));
  if (bytes.length !== snapshot.size ||
      createHash("sha256").update(bytes).digest("hex") !== snapshot.contentHash) {
    throw new Error("Snapshot integrity check failed");
  }
  return bytes;
}

export async function createFileSnapshot(projectId: string, filePath: string, reason = "Pre-change snapshot"): Promise<Omit<FileSnapshot, "blobKey">> {
  const project = await projectStore.get(projectId);
  if (!project) throw new Error("Project not found");
  const normalized = normalizeRelativePath(filePath);
  const current = await getProjectFile(project, normalized);
  if (!current) throw new Error("File not found");
  const snapshot = await saveBytes(projectId, normalized, current.bytes, current.mode, reason);
  const { blobKey: _blobKey, ...publicSnapshot } = snapshot;
  return publicSnapshot;
}

function lineDiff(before: string, after: string, maxLines = 400): { added: string[]; removed: string[]; truncated: boolean } {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const beforeSet = new Set(beforeLines);
  const afterSet = new Set(afterLines);
  const removed = beforeLines.filter((line) => !afterSet.has(line)).slice(0, maxLines);
  const added = afterLines.filter((line) => !beforeSet.has(line)).slice(0, maxLines);
  return {
    added,
    removed,
    truncated: beforeLines.length > maxLines || afterLines.length > maxLines
  };
}

export async function diffFileSnapshot(projectId: string, snapshotId: string): Promise<SnapshotDiff> {
  const snapshot = await projectStore.getSnapshot(projectId, snapshotId);
  if (!snapshot) throw new Error("Snapshot not found");
  const project = await projectStore.get(projectId);
  if (!project) throw new Error("Project not found");
  const savedBytes = await readSnapshot(snapshot);
  const current = await getProjectFile(project, snapshot.path);
  const currentHash = current ? createHash("sha256").update(current.bytes).digest("hex") : null;
  const diff = lineDiff(savedBytes.toString("utf8"), current?.bytes.toString("utf8") ?? "");
  const { blobKey: _blobKey, ...publicSnapshot } = snapshot;
  return {
    snapshot: publicSnapshot,
    currentHash,
    currentExists: current !== null,
    added: diff.added,
    removed: diff.removed,
    truncated: diff.truncated
  };
}

export async function restoreFileSnapshot(
  projectId: string,
  snapshotId: string,
  expectedCurrentHash: string | null
): Promise<{ restoredSnapshot: Omit<FileSnapshot, "blobKey">; safetySnapshot?: Omit<FileSnapshot, "blobKey"> }> {
  const snapshot = await projectStore.getSnapshot(projectId, snapshotId);
  if (!snapshot) throw new Error("Snapshot not found");
  const project = await projectStore.get(projectId);
  if (!project) throw new Error("Project not found");

  const normalized = normalizeRelativePath(snapshot.path);
  const current = await getProjectFile(project, normalized);
  const currentHash = current ? createHash("sha256").update(current.bytes).digest("hex") : null;
  if (currentHash !== expectedCurrentHash) {
    throw new Error("File changed since comparison; refresh the diff before restoring");
  }

  let safetySnapshot: FileSnapshot | undefined;
  if (current) safetySnapshot = await saveBytes(projectId, normalized, current.bytes, current.mode, "Before snapshot restore");

  const bytes = await readSnapshot(snapshot);
  const root = await realpath(project.root);
  const target = path.resolve(root, normalized);
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  const realParent = await realpath(parent);
  const parentRelative = path.relative(root, realParent);
  if (parentRelative.startsWith("..") || path.isAbsolute(parentRelative)) {
    throw new Error("Restore target resolves outside the project");
  }
  const currentInfo = await lstat(target).catch(() => null);
  if (currentInfo?.isSymbolicLink() || (currentInfo && !currentInfo.isFile())) {
    throw new Error("Restore target is not a regular file");
  }

  const temporaryPath = path.join(parent, `.${path.basename(target)}.${randomUUID()}.restore`);
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(snapshot.mode);
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, target);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }

  const { blobKey: _blobKey, ...publicSnapshot } = snapshot;
  return {
    restoredSnapshot: publicSnapshot,
    ...(safetySnapshot ? { safetySnapshot: (({ blobKey: _blobKey, ...rest }) => rest)(safetySnapshot) } : {})
  };
}
