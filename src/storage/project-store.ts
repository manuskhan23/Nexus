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
  mode: number;
  createdAt: string;
  reason: string;
  blobKey: string;
}

export type TaskStatus = "pending" | "planning" | "awaiting_approval" | "running" | "paused" | "failed" | "completed" | "cancelled";
export type TaskStepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface TaskStepRecord {
  id: string;
  title: string;
  description: string;
  dependencies: string[];
  status: TaskStepStatus;
  startedAt?: string;
  completedAt?: string;
  result?: string;
}

export interface TaskEventRecord {
  id: string;
  at: string;
  type: string;
  message: string;
  stepId?: string;
}

export interface TaskRecord {
  id: string;
  projectId: string;
  title: string;
  description: string;
  priority: "low" | "normal" | "high";
  status: TaskStatus;
  steps: TaskStepRecord[];
  currentStepId: string | null;
  progress: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  events: TaskEventRecord[];
}

export interface EditProposalChange {
  path: string;
  action: "write" | "delete" | "move";
  expectedHash: string | null;
  destinationPath?: string;
  contentBlobKey?: string;
  contentHash?: string;
  size: number;
}

export interface EditProposal {
  id: string;
  projectId: string;
  title: string;
  status: "pending" | "applying" | "applied" | "rejected" | "failed";
  changes: EditProposalChange[];
  createdAt: string;
  completedAt?: string;
  snapshotIds?: string[];
  failureMessage?: string;
}

interface StoredProject extends ProjectRecord {}
interface StoredFile extends IndexedFile {
  projectId: string;
}
interface StoredSnapshot extends FileSnapshot {}
interface StoredEditProposal extends EditProposal {}
interface StoredTask extends TaskRecord {}

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
        database.collection<StoredSnapshot>("file_snapshots").createIndex({ projectId: 1, path: 1, createdAt: -1 }),
        database.collection<StoredEditProposal>("edit_proposals").createIndex({ id: 1 }, { unique: true }),
        database.collection<StoredEditProposal>("edit_proposals").createIndex({ projectId: 1, createdAt: -1 }),
        database.collection<StoredTask>("tasks").createIndex({ id: 1 }, { unique: true }),
        database.collection<StoredTask>("tasks").createIndex({ projectId: 1, updatedAt: -1 })
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
  editProposals: Collection<StoredEditProposal>;
  tasks: Collection<StoredTask>;
}> {
  await connect();
  return {
    projects: database!.collection<StoredProject>("projects"),
    files: database!.collection<StoredFile>("project_files"),
    snapshots: database!.collection<StoredSnapshot>("file_snapshots"),
    editProposals: database!.collection<StoredEditProposal>("edit_proposals"),
    tasks: database!.collection<StoredTask>("tasks")
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
    return projects.find({}, { projection: { _id: 0 } }).sort({ addedAt: 1 }).toArray();
  },
  async get(id: string): Promise<ProjectRecord | undefined> {
    const { projects } = await collections();
    const document = await projects.findOne({ id });
    return document ? publicProject(document) : undefined;
  },
  async listIndexedFiles(id: string): Promise<IndexedFile[]> {
    const { files } = await collections();
    return files.find({ projectId: id }, { projection: { _id: 0, projectId: 0 } }).toArray();
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
    return (await snapshots.findOne({ projectId, id: snapshotId }, { projection: { _id: 0 } })) ?? undefined;
  },
  async listSnapshots(projectId: string, relativePath?: string): Promise<FileSnapshot[]> {
    const { snapshots } = await collections();
    const filter = relativePath ? { projectId, path: relativePath } : { projectId };
    return snapshots.find(filter, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(100).toArray();
  },
  async createEditProposal(proposal: EditProposal): Promise<void> {
    const { editProposals } = await collections();
    await editProposals.insertOne(proposal);
  },
  async getEditProposal(projectId: string, id: string): Promise<EditProposal | undefined> {
    const { editProposals } = await collections();
    return (await editProposals.findOne({ projectId, id }, { projection: { _id: 0 } })) ?? undefined;
  },
  async listEditProposals(projectId: string): Promise<EditProposal[]> {
    const { editProposals } = await collections();
    return editProposals.find({ projectId }, { projection: { _id: 0 } })
      .sort({ createdAt: -1 }).limit(50).toArray();
  },
  async claimEditProposal(projectId: string, id: string): Promise<boolean> {
    const { editProposals } = await collections();
    const result = await editProposals.updateOne(
      { projectId, id, status: "pending" },
      { $set: { status: "applying" } }
    );
    return result.modifiedCount === 1;
  },
  async finishEditProposal(
    projectId: string,
    id: string,
    status: "applied" | "rejected" | "failed",
    completedAt: string,
    failureMessage?: string,
    snapshotIds?: string[]
  ): Promise<void> {
    const { editProposals } = await collections();
    const set = {
      status,
      completedAt,
      ...(failureMessage ? { failureMessage: failureMessage.slice(0, 500) } : {}),
      ...(snapshotIds ? { snapshotIds } : {})
    };
    if (failureMessage) {
      await editProposals.updateOne({ projectId, id }, { $set: set });
    } else {
      await editProposals.updateOne({ projectId, id }, { $set: set, $unset: { failureMessage: "" as const } });
    }
  },
  async addTask(task: TaskRecord): Promise<void> {
    const { tasks } = await collections();
    await tasks.insertOne(task);
  },
  async getTask(projectId: string, id: string): Promise<TaskRecord | undefined> {
    const { tasks } = await collections();
    return (await tasks.findOne({ projectId, id }, { projection: { _id: 0 } })) ?? undefined;
  },
  async listTasks(projectId: string): Promise<TaskRecord[]> {
    const { tasks } = await collections();
    return tasks.find({ projectId }, { projection: { _id: 0 } }).sort({ updatedAt: -1 }).limit(100).toArray();
  },
  async saveTask(task: TaskRecord, expectedUpdatedAt: string): Promise<boolean> {
    const { tasks } = await collections();
    const result = await tasks.replaceOne({ projectId: task.projectId, id: task.id, updatedAt: expectedUpdatedAt }, task);
    return result.modifiedCount === 1;
  },
  async close(): Promise<void> {
    await client?.close();
    client = undefined;
    database = undefined;
    connectPromise = undefined;
  }
};
