import {
  applyEditProposal,
  prepareEditProposal,
  readProjectFile,
  rejectEditProposal,
  type EditChangeInput
} from "../code-editing/edit-service.js";
import { ToolRegistry } from "./tool-registry.js";

function objectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Tool input must be an object");
  return input as Record<string, unknown>;
}

function projectPathInput(input: unknown): { projectId: string; path: string } {
  const value = objectInput(input);
  if (typeof value.projectId !== "string" || typeof value.path !== "string") {
    throw new Error("Project identifier and relative path are required");
  }
  return { projectId: value.projectId, path: value.path };
}

function proposalInput(input: unknown): { projectId: string; proposalId: string } {
  const value = objectInput(input);
  if (typeof value.projectId !== "string" || typeof value.proposalId !== "string") {
    throw new Error("Project and proposal identifiers are required");
  }
  return { projectId: value.projectId, proposalId: value.proposalId };
}

export const toolRegistry = new ToolRegistry();

toolRegistry.register({
  id: "files.read",
  name: "Read project file",
  description: "Read a bounded, non-secret project text file",
  risk: "low",
  timeoutMs: 10_000,
  validate: projectPathInput,
  execute: (input) => readProjectFile(input.projectId, input.path)
});

toolRegistry.register({
  id: "edits.prepare",
  name: "Prepare edit proposal",
  description: "Stage a bounded file change for user review",
  risk: "low",
  timeoutMs: 30_000,
  validate(input) {
    const value = objectInput(input);
    if (typeof value.projectId !== "string" || typeof value.title !== "string" || !Array.isArray(value.changes)) {
      throw new Error("Project, title, and changes are required");
    }
    return {
      projectId: value.projectId,
      title: value.title,
      changes: value.changes as EditChangeInput[]
    };
  },
  execute: (input) => prepareEditProposal(input.projectId, input.title, input.changes)
});

toolRegistry.register({
  id: "edits.apply",
  name: "Apply reviewed edits",
  description: "Apply only a user-approved, conflict-free edit proposal",
  risk: "high",
  timeoutMs: 60_000,
  validate: proposalInput,
  execute: (input) => applyEditProposal(input.projectId, input.proposalId)
});

toolRegistry.register({
  id: "edits.reject",
  name: "Reject edit proposal",
  description: "Reject a staged proposal without changing project files",
  risk: "low",
  timeoutMs: 10_000,
  validate: proposalInput,
  execute: async (input) => {
    await rejectEditProposal(input.projectId, input.proposalId);
    return { rejected: true };
  }
});
