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

interface StoredProject extends ProjectRecord {}
interface StoredFile extends IndexedFile {
  projectId: string;
}

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
        database.collection<StoredFile>("project_files").createIndex({ projectId: 1, language: 1 })
      ]);
    })();
  }
  try {
    await connectPromise;
  } catch (error) {
    connectPromise = undefined;
    client = undefined;
    database = undefined;
    throw error;
  }
}

async function collections(): Promise<{ projects: Collection<StoredProject>; files: Collection<StoredFile> }> {
  await connect();
  return {
    projects: database!.collection<StoredProject>("projects"),
    files: database!.collection<StoredFile>("project_files")
  };
}

function publicProject(document: WithId<StoredProject>): ProjectRecord {
  const { _id: _ignored, ...project } = document;
  return project;
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
    await projects.updateOne(
      { id },
      { $set: { lastIndexedAt: indexedAt }, $inc: { indexVersion: 1 } }
    );
  },
  async close(): Promise<void> {
    await client?.close();
    client = undefined;
    database = undefined;
    connectPromise = undefined;
  }
};
