import { MongoClient, type Collection, type Db, type WithId } from "mongodb";
import type { IndexedFile } from "../project-intelligence/scanner.js";

export interface ProjectRecord {
  id: string;
  name: string;
  root: string;
  addedAt: string;
  lastIndexedAt: string | null;
  indexVersion: number;
}

export interface FileSnapshot {
  id: string;
  projectId: string;
  path: string;
  contentHash: string;
  size: number;
  createdAt: string;
  reason: string;
  blobKey: string;
}

interface StoredProject extends ProjectRecord {}
interface StoredFile extends IndexedFile {
  projectId: string;
}
interface StoredSnapshot extends FileSnapshot {}

let client: MongoClient | undefined;
let database: Db | undefined;
let connectPromise: Promise<void> | undefined;

async function connect(): Promise<void> {
  if (database) return;
  if (!connectPromise) {
    connectPromise = (async () => {
      const uri = process.env.MONGODB_URI;
      if (!uri) throw new Error("MONGODB_URI must be configured before using project storage");
      client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
      await client.connect();
      database = client.db(process.env.MONGODB_DATABASE || "nexus");
      await Promise.all([
        database.collection<StoredProject>("projects").createIndex({ id: 1 }, { unique: true }),
        database.collection<StoredProject>("projects").createIndex({ root: 1 }, { unique: true }),
        database.collection<StoredFile>("project_files").createIndex({ projectId: 1, path: 1 }, { unique: true }),
        database.collection<StoredFile>("project_files").createIndex({ projectId: 1, language: 1 }),
        database.collection<StoredSnapshot>("file_snapshots").createIndex({ id: 1 }, { unique: true }),
        database.collection<StoredSnapshot>("file_snapshots").createIndex({ projectId: 1, path: 1, createdAt: -1 })
      ]);
    })();
  }
  try {
    await connectPromise;
  } catch (error) {
    connectPromise = undefined;
    await client?.close().catch(() => undefined);
    client = undefined;
    database = undefined;
    throw error;
  }
}

async function collections(): Promise<{
  projects: Collection<StoredProject>;
  files: Collection<StoredFile>;
  snapshots: Collection<StoredSnapshot>;
}> {
  await connect();
  return {
    projects: database!.collection<StoredProject>("projects"),
    files: database!.collection<StoredFile>("project_files"),
    snapshots: database!.collection<StoredSnapshot>("file_snapshots")
  };
}

function publicProject(document: WithId<StoredProject>): ProjectRecord {
  const { _id: _ignored, ...project } = document;
  return project;
}

async function touch(projects: Collection<StoredProject>, id: string, indexedAt: string): Promise<void> {
  await projects.updateOne(
    { id },
    { $set: { lastIndexedAt: indexedAt }, $inc: { indexVersion: 1 } }
  );
}

export const projectStore = {
  async list(): Promise<ProjectRecord[]> {
    const { projects } = await collections();
    const documents = await projects.find({}, { projection: { _id: 0 } }).sort({ addedAt: 1 }).toArray();
    return documents;
  },
  async get(id: string): Promise<ProjectRecord | undefined> {
    const { projects } = await collections();
    const document = await projects.findOne({ id });
    return document ? publicProject(document) : undefined;
  },
  async listIndexedFiles(id: string): Promise<IndexedFile[]> {
    const { files } = await collections();
    return files.find(
      { projectId: id },
      { projection: { _id: 0, projectId: 0 } }
    ).toArray();
  },
  async add(project: ProjectRecord): Promise<void> {
    const { projects } = await collections();
    await projects.insertOne(project);
  },
  async remove(id: string): Promise<boolean> {
    const { projects, files } = await collections();
    const result = await projects.deleteOne({ id });
    if (result.deletedCount === 0) return false;
    await files.deleteMany({ projectId: id });
    return true;
  },
  async saveIndex(id: string, indexedFiles: IndexedFile[], indexedAt: string): Promise<void> {
    const { projects, files } = await collections();
    await files.deleteMany({ projectId: id });
    if (indexedFiles.length > 0) {
      await files.insertMany(indexedFiles.map((file) => ({ ...file, projectId: id })), { ordered: true });
    }
    await touch(projects, id, indexedAt);
  },
  async upsertIndexedFile(id: string, file: IndexedFile, indexedAt: string): Promise<void> {
    const { projects, files } = await collections();
    await files.replaceOne({ projectId: id, path: file.path }, { ...file, projectId: id }, { upsert: true });
    await touch(projects, id, indexedAt);
  },
  async removeIndexedFile(id: string, relativePath: string, indexedAt: string): Promise<void> {
    const { projects, files } = await collections();
    await files.deleteOne({ projectId: id, path: relativePath.replaceAll("\\", "/") });
    await touch(projects, id, indexedAt);
  },
  async addSnapshot(snapshot: FileSnapshot): Promise<void> {
    const { snapshots } = await collections();
    await snapshots.insertOne(snapshot);
  },
  async getSnapshot(projectId: string, snapshotId: string): Promise<FileSnapshot | undefined> {
    const { snapshots } = await collections();
    const document = await snapshots.findOne({ projectId, id: snapshotId }, { projection: { _id: 0 } });
    return document ?? undefined;
  },
  async listSnapshots(projectId: string, relativePath?: string): Promise<FileSnapshot[]> {
    const { snapshots } = await collections();
    const filter = relativePath ? { projectId, path: relativePath } : { projectId };
    return snapshots.find(filter, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(100).toArray();
  },
  async close(): Promise<void> {
    await client?.close();
    client = undefined;
    database = undefined;
    connectPromise = undefined;
  }
};
