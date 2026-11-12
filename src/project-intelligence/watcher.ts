import { watch, type FSWatcher } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { scanProject, type ProjectScan } from "./scanner.js";
import { scanProjectFile } from "./scan-file.js";
import { projectStore, type ProjectRecord } from "../storage/project-store.js";

const watchers = new Map<string, FSWatcher>();
const timers = new Map<string, NodeJS.Timeout>();
const DEBOUNCE_MS = 300;
const FULL_RESCAN_FILES = new Set([
  ".gitignore", "package.json", "package-lock.json", "pnpm-lock.yaml",
  "yarn.lock", "pyproject.toml", "Cargo.toml", "go.mod"
]);

async function rebuild(project: ProjectRecord): Promise<void> {
  const scan: ProjectScan = await scanProject(project.root);
  await projectStore.saveIndex(project.id, scan.files, scan.scannedAt);
}

async function applyChange(project: ProjectRecord, relativePath: string): Promise<void> {
  const normalized = relativePath.replaceAll(path.sep, "/");
  if (FULL_RESCAN_FILES.has(normalized) || normalized.endsWith("/.gitignore")) {
    await rebuild(project);
    return;
  }

  const absolute = path.resolve(project.root, relativePath);
  try {
    const stat = await lstat(absolute);
    if (stat.isDirectory()) {
      await rebuild(project);
      return;
    }
  } catch {
    // A deleted directory can contain many indexed descendants; rebuild removes them all.
    await rebuild(project);
    return;
  }

  const indexed = await scanProjectFile(project.root, relativePath);
  const changedAt = new Date().toISOString();
  if (indexed) {
    await projectStore.upsertIndexedFile(project.id, indexed, changedAt);
  } else {
    // Index paths use forward slashes on every platform.
    await projectStore.removeIndexedFile(project.id, normalized, changedAt);
  }
}

function schedule(project: ProjectRecord, filename: string | Buffer | null): void {
  if (!filename) {
    const key = project.id + ":*";
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      void rebuild(project).catch((error: unknown) => report(project, error));
    }, DEBOUNCE_MS));
    return;
  }
  const relativePath = filename.toString();
  if (!relativePath || path.isAbsolute(relativePath)) return;
  const key = project.id + ":" + relativePath;
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    void applyChange(project, relativePath).catch((error: unknown) => report(project, error));
  }, DEBOUNCE_MS));
}

function report(project: ProjectRecord, error: unknown): void {
  console.error(JSON.stringify({
    event: "project.index_update_failed",
    projectId: project.id,
    message: error instanceof Error ? error.message : "Unknown watcher error"
  }));
}

export function watchProject(project: ProjectRecord): void {
  if (watchers.has(project.id)) return;
  try {
    const watcher = watch(project.root, { recursive: true }, (_event, filename) => schedule(project, filename));
    watcher.on("error", (error) => report(project, error));
    watchers.set(project.id, watcher);
  } catch (error) {
    report(project, error);
  }
}

export function watchProjects(projects: ProjectRecord[]): void {
  for (const project of projects) watchProject(project);
}

export function unwatchProject(id: string): void {
  watchers.get(id)?.close();
  watchers.delete(id);
  for (const [key, timer] of timers) {
    if (key.startsWith(id + ":")) {
      clearTimeout(timer);
      timers.delete(key);
    }
  }
}

export function stopProjectWatchers(): void {
  for (const id of watchers.keys()) unwatchProject(id);
}
