import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EditProposal, EditProposalChange, ProjectRecord } from "../storage/project-store.js";
import { projectStore } from "../storage/project-store.js";
import { createFileSnapshot, diffFileSnapshot, restoreFileSnapshot } from "../version-history/snapshot-service.js";
import { buildTextDiff } from "./diff.js";
import { applyTextPatches, type TextPatch } from "./patch.js";
import { normalizeEditPath, resolveProjectPath } from "./path-utils.js";

const MAX_FILE_BYTES = 1_000_000;
const MAX_PROPOSAL_BYTES = 4_000_000;
const MAX_CHANGES = 20;
const HASH = /^[a-f0-9]{64}$/i;
const ID = /^[0-9a-f-]{36}$/i;

export interface FileReadResult {
  path: string;
  exists: boolean;
  hash: string | null;
  content: string;
  size: number;
}

export interface EditChangeInput {
  path: string;
  action: "write" | "delete" | "move";
  expectedHash: string | null;
  destinationPath?: string;
  content?: string;
  patches?: TextPatch[];
}

export interface EditChangeView extends Omit<EditProposalChange, "contentBlobKey" | "contentHash"> {
  currentHash: string | null;
  conflict: boolean;
  diff: string[];
  diffTruncated: boolean;
}

export interface EditProposalView extends Omit<EditProposal, "changes"> {
  changes: EditChangeView[];
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function findProjectFile(root: string, relativePath: string): Promise<{ absolute: string; bytes: Buffer; mode: number } | null> {
  const absolute = resolveProjectPath(root, relativePath);
  const normalized = normalizeEditPath(relativePath);
  let cursor = root;
  try {
    for (const [index, part] of normalized.split("/").entries()) {
      cursor = path.join(cursor, part);
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new Error("Symbolic links cannot be read or edited");
      if (index < normalized.split("/").length - 1 && !info.isDirectory()) {
        throw new Error("A file path parent is not a directory");
      }
      if (index === normalized.split("/").length - 1) {
        if (!info.isFile()) throw new Error("Only regular files can be edited");
        if (info.size > MAX_FILE_BYTES) throw new Error("File exceeds the 1 MiB editing limit");
        const actual = await realpath(cursor);
        const relative = path.relative(root, actual);
        if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          throw new Error("File resolves outside the project");
        }
        const bytes = await readFile(actual);
        if (bytes.length > MAX_FILE_BYTES) throw new Error("File grew beyond the editing limit");
        if (bytes.includes(0)) throw new Error("Binary files cannot be edited");
        return { absolute, bytes, mode: info.mode & 0o777 };
      }
    }
    return null;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function resolveProject(projectId: string): Promise<{ project: ProjectRecord; root: string }> {
  const project = await projectStore.get(projectId);
  if (!project) throw new Error("Project not found");
  return { project, root: await realpath(project.root) };
}

async function proposalDirectory(): Promise<string> {
  const base = process.env.NEXUS_DATA_DIR || path.join(os.homedir(), ".nexus-ai");
  const directory = path.join(base, "edit-proposals");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

async function writeStagedContent(key: string, bytes: Buffer): Promise<void> {
  const directory = await proposalDirectory();
  const temporary = path.join(directory, `${key}.tmp`);
  const destination = path.join(directory, key);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, destination);
}

async function readStagedContent(change: EditProposalChange): Promise<Buffer> {
  if (!change.contentBlobKey || !ID.test(change.contentBlobKey.replace(/\.content$/, "")) ||
      change.contentBlobKey !== `${change.contentBlobKey.replace(/\.content$/, "")}.content` ||
      !change.contentHash) throw new Error("Invalid staged change reference");
  const bytes = await readFile(path.join(await proposalDirectory(), change.contentBlobKey));
  if (bytes.length !== change.size || hash(bytes) !== change.contentHash) {
    throw new Error("Staged change integrity check failed");
  }
  return bytes;
}

export async function readProjectFile(projectId: string, filePath: string): Promise<FileReadResult> {
  const { root } = await resolveProject(projectId);
  const normalized = normalizeEditPath(filePath);
  const current = await findProjectFile(root, normalized);
  return current
    ? { path: normalized, exists: true, hash: hash(current.bytes), content: current.bytes.toString("utf8"), size: current.bytes.length }
    : { path: normalized, exists: false, hash: null, content: "", size: 0 };
}

export async function prepareEditProposal(
  projectId: string,
  title: string,
  inputChanges: EditChangeInput[]
): Promise<EditProposalView> {
  const { root } = await resolveProject(projectId);
  const cleanTitle = title.trim().slice(0, 160);
  if (!cleanTitle || inputChanges.length === 0 || inputChanges.length > MAX_CHANGES) {
    throw new Error("Provide a title and between 1 and 20 file changes");
  }

  const seen = new Set<string>();
  let totalBytes = 0;
  const staged: Array<{ change: EditProposalChange; bytes?: Buffer }> = [];
  for (const input of inputChanges) {
    const filePath = normalizeEditPath(input.path);
    if (seen.has(filePath)) throw new Error("Each proposal may change a file only once");
    seen.add(filePath);
    if (input.expectedHash !== null && (typeof input.expectedHash !== "string" || !HASH.test(input.expectedHash))) {
      throw new Error("A valid inspected file hash is required");
    }
    const current = await findProjectFile(root, filePath);
    const currentHash = current ? hash(current.bytes) : null;
    if (currentHash !== input.expectedHash) {
      throw new Error(`File changed since inspection: ${filePath}`);
    }

    if (input.action === "delete") {
      if (!current) throw new Error(`Cannot delete a file that does not exist: ${filePath}`);
      staged.push({ change: { path: filePath, action: "delete", expectedHash: currentHash, size: current.bytes.length } });
      continue;
    }
    if (input.action === "move") {
      if (!current || typeof input.destinationPath !== "string") {
        throw new Error("Moving a file requires an existing source and a destination path");
      }
      const destinationPath = normalizeEditPath(input.destinationPath);
      if (destinationPath === filePath) throw new Error("Source and destination paths are the same");
      if (await findProjectFile(root, destinationPath)) throw new Error(`Move destination already exists: ${destinationPath}`);
      totalBytes += current.bytes.length;
      if (totalBytes > MAX_PROPOSAL_BYTES) throw new Error("Proposal content exceeds the 4 MiB limit");
      staged.push({
        bytes: current.bytes,
        change: { path: filePath, action: "move", destinationPath, expectedHash: currentHash, size: current.bytes.length }
      });
      continue;
    }
    if (input.action !== "write") throw new Error("Unsupported edit operation");
    if (input.content !== undefined && input.patches !== undefined) {
      throw new Error("Choose either full text content or structured patches");
    }
    let content: string;
    if (typeof input.content === "string") {
      content = input.content;
    } else if (Array.isArray(input.patches) && current) {
      content = applyTextPatches(current.bytes.toString("utf8"), input.patches);
    } else {
      throw new Error("Write changes require text content or patches against an existing file");
    }
    const bytes = Buffer.from(content, "utf8");
    if (bytes.includes(0) || bytes.length > MAX_FILE_BYTES) throw new Error("Edited content must be text no larger than 1 MiB");
    totalBytes += bytes.length;
    if (totalBytes > MAX_PROPOSAL_BYTES) throw new Error("Proposal content exceeds the 4 MiB limit");
    staged.push({
      bytes,
      change: {
        path: filePath,
        action: "write",
        expectedHash: currentHash,
        size: bytes.length
      }
    });
  }

  const id = randomUUID();
  const changes: EditProposalChange[] = [];
  const written: string[] = [];
  let persisted = false;
  try {
    for (const item of staged) {
      if (!item.bytes) {
        changes.push(item.change);
        continue;
      }
      const key = `${randomUUID()}.content`;
      await writeStagedContent(key, item.bytes);
      written.push(key);
      changes.push({ ...item.change, contentBlobKey: key, contentHash: hash(item.bytes) });
    }
    const proposal: EditProposal = {
      id,
      projectId,
      title: cleanTitle,
      status: "pending",
      changes,
      createdAt: new Date().toISOString()
    };
    await projectStore.createEditProposal(proposal);
    persisted = true;
    return await getEditProposal(projectId, id);
  } catch (error) {
    if (!persisted) {
      const directory = await proposalDirectory();
      await Promise.all(written.map((key) => unlink(path.join(directory, key)).catch(() => undefined)));
    }
    throw error;
  }
}

export async function getEditProposal(projectId: string, id: string): Promise<EditProposalView> {
  if (!ID.test(id)) throw new Error("Invalid edit proposal identifier");
  const { root } = await resolveProject(projectId);
  const proposal = await projectStore.getEditProposal(projectId, id);
  if (!proposal) throw new Error("Edit proposal not found");
  const changes: EditChangeView[] = [];
  for (const change of proposal.changes) {
    const current = await findProjectFile(root, change.path);
    const currentHash = current ? hash(current.bytes) : null;
    const before = current?.bytes.toString("utf8") ?? "";
    const after = change.action === "write"
      ? (await readStagedContent(change)).toString("utf8")
      : "";
    const diff = buildTextDiff(before, after);
    changes.push({
      path: change.path,
      action: change.action,
      expectedHash: change.expectedHash,
      ...(change.destinationPath ? { destinationPath: change.destinationPath } : {}),
      size: change.size,
      currentHash,
      conflict: currentHash !== change.expectedHash ||
        (change.action === "move" && Boolean(await findProjectFile(root, change.destinationPath!))),
      diff: diff.lines,
      diffTruncated: diff.truncated
    });
  }
  return { ...proposal, changes };
}

async function ensureParentDirectories(root: string, relativePath: string): Promise<string> {
  const parts = path.dirname(relativePath).split("/").filter(Boolean);
  let parent = root;
  for (const part of parts) {
    parent = path.join(parent, part);
    let info = await lstat(parent).catch((error: unknown) => isMissing(error) ? null : Promise.reject(error));
    if (!info) {
      await mkdir(parent, { mode: 0o700 });
      info = await lstat(parent);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("Edit parent must be a real directory inside the project");
    }
    const actual = await realpath(parent);
    const relative = path.relative(root, actual);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Edit parent resolves outside the project");
    }
  }
  return parent;
}

async function atomicWrite(
  absolute: string,
  bytes: Buffer,
  mode: number,
  expectedCurrentHash: string | null
): Promise<void> {
  const temporary = path.join(path.dirname(absolute), `.${path.basename(absolute)}.${randomUUID()}.nexus-tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(mode);
  } finally {
    await handle.close();
  }
  try {
    if (expectedCurrentHash === null) {
      await link(temporary, absolute);
      await unlink(temporary).catch(() => undefined);
    } else {
      const current = await readFile(absolute).catch((error: unknown) => {
        if (isMissing(error)) return null;
        throw error;
      });
      if (!current || hash(current) !== expectedCurrentHash) {
        throw new Error("File changed while the edit was being written");
      }
      await rename(temporary, absolute);
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function rejectEditProposal(projectId: string, id: string): Promise<void> {
  const proposal = await projectStore.getEditProposal(projectId, id);
  if (!proposal) throw new Error("Edit proposal not found");
  if (!(await projectStore.claimEditProposal(projectId, id))) throw new Error("Proposal is no longer pending");
  await projectStore.finishEditProposal(projectId, id, "rejected", new Date().toISOString());
}

export async function applyEditProposal(projectId: string, id: string): Promise<{ status: "applied"; snapshotIds: string[] }> {
  const { root } = await resolveProject(projectId);
  const proposal = await projectStore.getEditProposal(projectId, id);
  if (!proposal) throw new Error("Edit proposal not found");
  if (proposal.status !== "pending") throw new Error("Proposal is no longer pending");

  const stagedBytes = new Map<EditProposalChange, Buffer>();
  for (const change of proposal.changes) {
    if (change.action === "write" || change.action === "move") stagedBytes.set(change, await readStagedContent(change));
    const current = await findProjectFile(root, change.path);
    if ((current ? hash(current.bytes) : null) !== change.expectedHash) {
      throw new Error(`File changed since proposal review: ${change.path}`);
    }
    if (change.action === "move" && await findProjectFile(root, change.destinationPath!)) {
      throw new Error(`Move destination changed since proposal review: ${change.destinationPath}`);
    }
  }
  if (!(await projectStore.claimEditProposal(projectId, id))) throw new Error("Proposal is no longer pending");

  const snapshotIds = new Map<string, string>();
  const applied: EditProposalChange[] = [];
  const moveTargetsCreated = new Set<EditProposalChange>();
  try {
    for (const change of proposal.changes) {
      const current = await findProjectFile(root, change.path);
      if ((current ? hash(current.bytes) : null) !== change.expectedHash) {
        throw new Error(`File changed before apply: ${change.path}`);
      }
      if (current) {
        const snapshot = await createFileSnapshot(projectId, change.path, `Before edit proposal ${id}`);
        snapshotIds.set(change.path, snapshot.id);
      }
    }

    for (const change of proposal.changes) {
      const current = await findProjectFile(root, change.path);
      if ((current ? hash(current.bytes) : null) !== change.expectedHash) {
        throw new Error(`File changed during apply: ${change.path}`);
      }
      if (change.action === "move") {
        if (!current || await findProjectFile(root, change.destinationPath!)) {
          throw new Error(`Move destination changed during apply: ${change.destinationPath}`);
        }
        const destination = resolveProjectPath(root, change.destinationPath!);
        const parent = await ensureParentDirectories(root, change.destinationPath!);
        const bytes = stagedBytes.get(change);
        if (!bytes) throw new Error("Staged move content is unavailable");
        await atomicWrite(path.join(parent, path.basename(destination)), bytes, current.mode, null);
        moveTargetsCreated.add(change);
        const sourceNow = await findProjectFile(root, change.path);
        if (!sourceNow || hash(sourceNow.bytes) !== change.expectedHash) {
          throw new Error(`File changed during move: ${change.path}`);
        }
        await unlink(current.absolute);
      } else if (change.action === "delete") {
        if (current) await unlink(current.absolute);
      } else {
        const absolute = resolveProjectPath(root, change.path);
        const parent = await ensureParentDirectories(root, change.path);
        const bytes = stagedBytes.get(change);
        if (!bytes) throw new Error("Staged edit content is unavailable");
        await atomicWrite(path.join(parent, path.basename(absolute)), bytes, current?.mode ?? 0o644, change.expectedHash);
      }
      applied.push(change);
    }

    const recoveryIds = Array.from(snapshotIds.values());
    await projectStore.finishEditProposal(projectId, id, "applied", new Date().toISOString(), undefined, recoveryIds);
    return { status: "applied", snapshotIds: recoveryIds };
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const change of [...proposal.changes].reverse()) {
      try {
        const snapshotId = snapshotIds.get(change.path);
        if (change.action === "move") {
          const destination = await findProjectFile(root, change.destinationPath!);
          const staged = stagedBytes.get(change);
          if (moveTargetsCreated.has(change) && destination && staged && hash(destination.bytes) === hash(staged)) {
            await unlink(destination.absolute);
          } else if (destination) {
            rollbackFailures.push(change.destinationPath!);
            continue;
          }
          const source = await findProjectFile(root, change.path);
          if (source && hash(source.bytes) === change.expectedHash) continue;
          if (!snapshotId) {
            rollbackFailures.push(change.path);
            continue;
          }
          const comparison = await diffFileSnapshot(projectId, snapshotId);
          if (comparison.currentHash !== null) {
            rollbackFailures.push(change.path);
            continue;
          }
          await restoreFileSnapshot(projectId, snapshotId, null);
          continue;
        }
        if (!applied.includes(change)) continue;
        if (snapshotId) {
          const comparison = await diffFileSnapshot(projectId, snapshotId);
          const expectedAfter = change.action === "write"
            ? hash(stagedBytes.get(change)!)
            : null;
          if (comparison.currentHash !== expectedAfter) {
            rollbackFailures.push(change.path);
            continue;
          }
          await restoreFileSnapshot(projectId, snapshotId, comparison.currentHash);
        } else if (change.action === "write") {
          const current = await findProjectFile(root, change.path);
          const expectedAfter = hash(stagedBytes.get(change)!);
          if (current && hash(current.bytes) === expectedAfter) await unlink(current.absolute);
          else rollbackFailures.push(change.path);
        }
      } catch {
        rollbackFailures.push(change.path);
      }
    }
    const baseMessage = error instanceof Error ? error.message : "Edit apply failed";
    const message = rollbackFailures.length
      ? `${baseMessage}; rollback needs attention for: ${rollbackFailures.join(", ")}`
      : baseMessage;
    await projectStore.finishEditProposal(projectId, id, "failed", new Date().toISOString(), message);
    throw new Error(message);
  }
}
