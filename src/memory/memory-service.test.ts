import assert from "node:assert/strict";
import test from "node:test";
import { assertMemorySafeText, formatMemoryContext } from "./memory-service.js";
import type { MemoryRecord } from "../storage/project-store.js";

test("memory secret filter rejects credentials and private keys", () => {
  assert.throws(() => assertMemorySafeText("api_key=supersecret"), /credential or private key/);
  assert.throws(() => assertMemorySafeText("mongodb://user:password@cluster.example/db"), /credential or private key/);
  assert.throws(() => assertMemorySafeText("-----BEGIN RSA PRIVATE KEY-----"), /credential or private key/);
  assert.doesNotThrow(() => assertMemorySafeText("Use TypeScript and keep API handlers small."));
});

test("memory context labels scope and stays within the configured limit", () => {
  const base = {
    id: "memory-id", title: "Preference", enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
  };
  const records: MemoryRecord[] = [
    { ...base, projectId: null, content: "Prefer concise error messages." },
    { ...base, id: "project-id", projectId: "project", title: "Architecture", content: "Use repository services." },
    { ...base, id: "large-id", projectId: "project", title: "Large", content: "x".repeat(6000) }
  ];
  const text = formatMemoryContext(records);
  assert.match(text, /user memory: Preference/);
  assert.match(text, /project memory: Architecture/);
  assert.doesNotMatch(text, /large-id/);
});
