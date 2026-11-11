import { randomUUID } from "node:crypto";
import type { TaskRecord, TaskStatus, TaskStepRecord, TaskStepStatus } from "../storage/project-store.js";
import { projectStore } from "../storage/project-store.js";

const MAX_STEPS = 30;
const MAX_EVENTS = 100;
const TASK_STATUSES = new Set<TaskStatus>([
  "pending", "planning", "awaiting_approval", "running", "paused", "failed", "completed", "cancelled"
]);
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ["planning", "cancelled"],
  planning: ["awaiting_approval", "paused", "failed", "cancelled"],
  awaiting_approval: ["running", "paused", "cancelled"],
  running: ["paused", "failed", "completed", "cancelled"],
  paused: ["planning", "running", "cancelled"],
  failed: ["planning", "running", "cancelled"],
  completed: [],
  cancelled: []
};

export interface TaskStepInput {
  title: string;
  description?: string;
  dependencies?: number[];
}

export function validateTaskPlan(steps: TaskStepInput[]): void {
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > MAX_STEPS) {
    throw new Error("A plan must contain between 1 and 30 steps");
  }
  for (const [index, step] of steps.entries()) {
    if (!step || typeof step.title !== "string" || !step.title.trim() || step.title.length > 160 ||
        (step.description !== undefined && (typeof step.description !== "string" || step.description.length > 2000)) ||
        (step.dependencies !== undefined && !Array.isArray(step.dependencies))) {
      throw new Error(`Invalid task step ${index + 1}`);
    }
    const dependencies = step.dependencies ?? [];
    if (dependencies.some((dependency) => !Number.isInteger(dependency) || dependency < 0 ||
      dependency >= steps.length || dependency === index) || new Set(dependencies).size !== dependencies.length) {
      throw new Error(`Invalid dependencies for step ${index + 1}`);
    }
  }

  const visited = new Set<number>();
  const visiting = new Set<number>();
  const visit = (index: number): void => {
    if (visiting.has(index)) throw new Error("Task plan dependencies contain a cycle");
    if (visited.has(index)) return;
    visiting.add(index);
    for (const dependency of steps[index].dependencies ?? []) visit(dependency);
    visiting.delete(index);
    visited.add(index);
  };
  steps.forEach((_step, index) => visit(index));
}

export function canTransitionTask(current: TaskStatus, next: TaskStatus): boolean {
  return TASK_STATUSES.has(current) && TASK_STATUSES.has(next) && TRANSITIONS[current].includes(next);
}

export function redactSecrets(value: string): string {
  return value
    .replace(/((?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/mongodb(?:\+srv)?:\/\/[^@\s]+@/gi, "mongodb://[redacted]@")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[redacted private key]");
}

function appendEvent(task: TaskRecord, type: string, message: string, stepId?: string): void {
  task.events.push({ id: randomUUID(), at: new Date().toISOString(), type, message: redactSecrets(message).slice(0, 500), ...(stepId ? { stepId } : {}) });
  if (task.events.length > MAX_EVENTS) task.events.splice(0, task.events.length - MAX_EVENTS);
}

export async function createTask(
  projectId: string,
  title: string,
  description: string,
  priority: TaskRecord["priority"],
  plan: TaskStepInput[]
): Promise<TaskRecord> {
  if (!await projectStore.get(projectId)) throw new Error("Project not found");
  if (typeof title !== "string" || !title.trim() || title.length > 160 ||
      typeof description !== "string" || description.length > 4000 ||
      !["low", "normal", "high"].includes(priority)) throw new Error("Invalid task details");
  validateTaskPlan(plan);
  const now = new Date().toISOString();
  const stepIds = plan.map(() => randomUUID());
  const steps: TaskStepRecord[] = plan.map((step, index) => ({
    id: stepIds[index],
    title: redactSecrets(step.title.trim()),
    description: redactSecrets((step.description ?? "").trim()),
    dependencies: (step.dependencies ?? []).map((dependency) => stepIds[dependency]),
    status: "pending"
  }));
  const task: TaskRecord = {
    id: randomUUID(),
    projectId,
    title: redactSecrets(title.trim()),
    description: redactSecrets(description.trim()),
    priority,
    status: "pending",
    steps,
    currentStepId: null,
    progress: 0,
    createdAt: now,
    updatedAt: now,
    events: []
  };
  appendEvent(task, "task.created", "Task and execution plan created");
  await projectStore.addTask(task);
  return task;
}

export async function transitionTask(projectId: string, id: string, next: TaskStatus, note = ""): Promise<TaskRecord> {
  const task = await projectStore.getTask(projectId, id);
  if (!task) throw new Error("Task not found");
  if (!canTransitionTask(task.status, next)) throw new Error(`Invalid task transition: ${task.status} to ${next}`);
  if (next === "completed" && task.steps.some((step) => step.status !== "completed" && step.status !== "skipped")) {
    throw new Error("Complete every plan step before completing the task");
  }
  const expectedUpdatedAt = task.updatedAt;
  const now = new Date().toISOString();
  task.status = next;
  task.updatedAt = now;
  if (next === "running" && !task.startedAt) task.startedAt = now;
  if (["completed", "cancelled", "failed"].includes(next)) task.completedAt = now;
  else if (next === "running" || next === "planning") delete task.completedAt;
  if (next === "running") {
    task.currentStepId = task.steps.find((step) => step.status === "running")?.id ??
      task.steps.find((step) =>
        step.status === "pending" && step.dependencies.every((dependency) => {
          const dependencyStatus = task.steps.find((candidate) => candidate.id === dependency)?.status;
          return dependencyStatus === "completed" || dependencyStatus === "skipped";
        })
      )?.id ?? null;
  }
  if (next === "failed") task.error = redactSecrets(note).slice(0, 500);
  else if (next === "running" || next === "planning") delete task.error;
  appendEvent(task, `task.${next}`, note || `Task moved to ${next}`);
  if (!await projectStore.saveTask(task, expectedUpdatedAt)) throw new Error("Task changed concurrently; reload and retry");
  return task;
}

export async function transitionTaskStep(
  projectId: string,
  taskId: string,
  stepId: string,
  next: TaskStepStatus,
  result = ""
): Promise<TaskRecord> {
  const task = await projectStore.getTask(projectId, taskId);
  if (!task) throw new Error("Task not found");
  if (task.status !== "running") throw new Error("Task steps can change only while the task is running");
  const step = task.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new Error("Task step not found");
  const allowed: Record<TaskStepStatus, TaskStepStatus[]> = {
    pending: ["running", "skipped"],
    running: ["completed", "failed"],
    completed: [],
    failed: ["pending", "running"],
    skipped: []
  };
  if (!allowed[step.status].includes(next)) throw new Error(`Invalid step transition: ${step.status} to ${next}`);
  if (next === "running" && step.dependencies.some((dependency) => {
    const status = task.steps.find((candidate) => candidate.id === dependency)?.status;
    return status !== "completed" && status !== "skipped";
  })) throw new Error("Complete the step dependencies first");
  if (next === "running" && task.steps.some((candidate) => candidate.status === "running")) {
    throw new Error("Finish the current running step first");
  }

  const expectedUpdatedAt = task.updatedAt;
  const now = new Date().toISOString();
  step.status = next;
  if (next === "running") step.startedAt = now;
  if (next === "completed" || next === "failed" || next === "skipped") step.completedAt = now;
  if (result) step.result = redactSecrets(result).slice(0, 2000);
  task.progress = Math.round(task.steps.filter((candidate) => candidate.status === "completed" || candidate.status === "skipped").length / task.steps.length * 100);
  task.currentStepId = task.steps.find((candidate) => candidate.status === "running")?.id ??
    task.steps.find((candidate) => candidate.status === "pending" && candidate.dependencies.every((dependency) =>
      ["completed", "skipped"].includes(task.steps.find((item) => item.id === dependency)?.status ?? "")
    ))?.id ?? null;
  task.updatedAt = now;
  appendEvent(task, `step.${next}`, result || `Step ${step.title} moved to ${next}`, step.id);
  if (!await projectStore.saveTask(task, expectedUpdatedAt)) throw new Error("Task changed concurrently; reload and retry");
  return task;
}
