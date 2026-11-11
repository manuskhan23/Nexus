import { randomUUID } from "node:crypto";
import { projectStore, type MemoryRecord } from "../storage/project-store.js";

const MAX_TITLE_CHARS = 120;
const MAX_CONTENT_CHARS = 4000;
const MAX_MEMORY_CONTEXT_CHARS = 6000;
const SECRET_PATTERNS = [
  /-----BEGIN [^-]*PRIVATE KEY-----/i,
  /mongodb(?:\+srv)?:\/\/[^\s:@]+:[^\s@]+@/i,
  /(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*[^\s,;]+/i,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/
];

export function assertMemorySafeText(value: string): void {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new Error("Memory text appears to contain a credential or private key; remove it before saving");
  }
}

function validateText(title: string, content: string): void {
  if (typeof title !== "string" || !title.trim() || title.length > MAX_TITLE_CHARS ||
      typeof content !== "string" || !content.trim() || content.length > MAX_CONTENT_CHARS) {
    throw new Error("Memory title (1-120 characters) and content (1-4000 characters) are required");
  }
  assertMemorySafeText(`${title}\n${content}`);
}

function assertScope(memory: MemoryRecord, projectId: string | null): void {
  if (memory.projectId !== null && memory.projectId !== projectId) throw new Error("Memory not found");
}

export async function listMemories(projectId: string): Promise<MemoryRecord[]> {
  if (!await projectStore.get(projectId)) throw new Error("Project not found");
  return projectStore.listMemories(projectId);
}

export async function createMemory(
  projectId: string,
  scope: "user" | "project",
  title: string,
  content: string
): Promise<MemoryRecord> {
  const project = await projectStore.get(projectId);
  if (!project) throw new Error("Project not found");
  validateText(title, content);
  const now = new Date().toISOString();
  const memory: MemoryRecord = {
    id: randomUUID(),
    projectId: scope === "user" ? null : projectId,
    title: title.trim(),
    content: content.trim(),
    enabled: true,
    createdAt: now,
    updatedAt: now
  };
  await projectStore.addMemory(memory);
  return memory;
}

export async function updateMemory(
  projectId: string,
  id: string,
  input: { title?: string; content?: string; enabled?: boolean }
): Promise<MemoryRecord> {
  if (!await projectStore.get(projectId)) throw new Error("Project not found");
  const memory = await projectStore.getMemory(id);
  if (!memory) throw new Error("Memory not found");
  assertScope(memory, projectId);
  const expectedUpdatedAt = memory.updatedAt;
  const title = input.title ?? memory.title;
  const content = input.content ?? memory.content;
  validateText(title, content);
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("Invalid memory enabled state");
  const updated: MemoryRecord = {
    ...memory,
    title: title.trim(),
    content: content.trim(),
    enabled: input.enabled ?? memory.enabled,
    updatedAt: new Date().toISOString()
  };
  if (!await projectStore.saveMemory(updated, expectedUpdatedAt)) throw new Error("Memory changed concurrently; reload and retry");
  return updated;
}

export async function removeMemory(projectId: string, id: string): Promise<boolean> {
  if (!await projectStore.get(projectId)) throw new Error("Project not found");
  const memory = await projectStore.getMemory(id);
  if (!memory) throw new Error("Memory not found");
  assertScope(memory, projectId);
  return projectStore.removeMemory(id);
}

export async function relevantMemories(projectId: string, query: string): Promise<MemoryRecord[]> {
  const memories = await listMemories(projectId);
  const terms = new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? []);
  return memories.filter((memory) => memory.enabled).map((memory) => ({
    memory,
    score: Array.from(terms).reduce((count, term) =>
      count + Number(`${memory.title} ${memory.content}`.toLocaleLowerCase().includes(term)), 0)
  })).filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || right.memory.updatedAt.localeCompare(left.memory.updatedAt))
    .slice(0, 5).map((item) => item.memory);
}

export function formatMemoryContext(memories: MemoryRecord[]): string {
  let remaining = MAX_MEMORY_CONTEXT_CHARS;
  const entries: string[] = [];
  for (const memory of memories) {
    const entry = `[${memory.projectId === null ? "user" : "project"} memory: ${memory.title}]\n${memory.content}`;
    if (entry.length > remaining) continue;
    entries.push(entry);
    remaining -= entry.length;
  }
  return entries.join("\n\n");
}
