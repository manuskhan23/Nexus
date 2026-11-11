import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IndexedFile } from "../project-intelligence/scanner.js";

export interface ProjectRecord {
  id: string;
  name: string;
  root: string;
  addedAt: string;
  lastIndexedAt: string | null;
  indexVersion: number;
}

function openDatabase(): Database.Database {
  const dataDirectory = process.env.NEXUS_DATA_DIR ?? path.join(os.homedir(), ".nexus-ai");
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const database = new Database(path.join(dataDirectory, "nexus.sqlite"));
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root TEXT NOT NULL UNIQUE,
      added_at TEXT NOT NULL,
      last_indexed_at TEXT,
      index_version INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS project_files (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      relative_path TEXT NOT NULL,
      size INTEGER NOT NULL,
      modified_at TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      language TEXT NOT NULL,
      PRIMARY KEY (project_id, relative_path)
    );
    CREATE INDEX IF NOT EXISTS idx_project_files_language
      ON project_files(project_id, language);
  `);
  return database;
}

const db = openDatabase();
const statements = {
  list: db.prepare(`SELECT id, name, root, added_at AS addedAt,
    last_indexed_at AS lastIndexedAt, index_version AS indexVersion
    FROM projects ORDER BY added_at`),
  get: db.prepare(`SELECT id, name, root, added_at AS addedAt,
    last_indexed_at AS lastIndexedAt, index_version AS indexVersion
    FROM projects WHERE id = ?`),
  add: db.prepare(`INSERT INTO projects (id, name, root, added_at)
    VALUES (@id, @name, @root, @addedAt)`),
  delete: db.prepare("DELETE FROM projects WHERE id = ?"),
  replaceIndex: db.prepare("DELETE FROM project_files WHERE project_id = ?"),
  addFile: db.prepare(`INSERT INTO project_files
    (project_id, relative_path, size, modified_at, sha256, language)
    VALUES (@projectId, @path, @size, @modifiedAt, @sha256, @language)`),
  updateIndexedAt: db.prepare(`UPDATE projects
    SET last_indexed_at = ?, index_version = index_version + 1 WHERE id = ?`)
};

const saveIndexTransaction = db.transaction((projectId: string, files: IndexedFile[], indexedAt: string) => {
  statements.replaceIndex.run(projectId);
  for (const file of files) statements.addFile.run({ projectId, ...file });
  statements.updateIndexedAt.run(indexedAt, projectId);
});

export const projectStore = {
  list(): ProjectRecord[] {
    return statements.list.all() as ProjectRecord[];
  },
  get(id: string): ProjectRecord | undefined {
    return statements.get.get(id) as ProjectRecord | undefined;
  },
  add(project: ProjectRecord): void {
    statements.add.run(project);
  },
  remove(id: string): boolean {
    return statements.delete.run(id).changes === 1;
  },
  saveIndex(id: string, files: IndexedFile[], indexedAt: string): void {
    saveIndexTransaction(id, files, indexedAt);
  }
};
