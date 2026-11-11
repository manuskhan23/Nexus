import assert from "node:assert/strict";
import test from "node:test";
import {
  generateText,
  getProviderStatuses,
  setProviderCredential
} from "./provider-service.js";

test("provider credentials are represented only by configured state", () => {
  setProviderCredential("gemini", "test-gemini-key-123");
  try {
    assert.deepEqual(getProviderStatuses(), [
      { id: "gemini", configured: true },
      { id: "groq", configured: false }
    ]);
  } finally {
    setProviderCredential("gemini", null);
  }
});

test("provider requests validate model and prompt bounds without network access", async () => {
  setProviderCredential("groq", "test-groq-key-123");
  try {
    await assert.rejects(generateText("groq", "", "system", "prompt"), /model identifier/);
    await assert.rejects(generateText("groq", "model-id", "x".repeat(30_001), "prompt"), /30000 character limit/);
  } finally {
    setProviderCredential("groq", null);
  }
});

test("Gemini request uses the supported endpoint and returns bounded text", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedKey: string | null = null;
  setProviderCredential("gemini", "test-gemini-key-123");
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedKey = new Headers(init?.headers).get("x-goog-api-key");
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "READY" }] } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await generateText("gemini", "gemini-test-model", "system", "prompt");
    assert.equal(result.text, "READY");
    assert.match(capturedUrl, /generativelanguage\.googleapis\.com/);
    assert.equal(capturedKey, "test-gemini-key-123");
  } finally {
    globalThis.fetch = originalFetch;
    setProviderCredential("gemini", null);
  }
});

test("Groq request uses bearer authentication and upstream errors do not expose secrets", async () => {
  const originalFetch = globalThis.fetch;
  let capturedAuthorization: string | null = null;
  setProviderCredential("groq", "test-groq-key-123");
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedAuthorization = new Headers(init?.headers).get("authorization");
    return new Response(JSON.stringify({ choices: [{ message: { content: "READY" } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await generateText("groq", "test-model", "system", "prompt");
    assert.equal(result.text, "READY");
    assert.equal(capturedAuthorization, "Bearer test-groq-key-123");

    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "secret=test-groq-key-123" }), { status: 401 })) as typeof fetch;
    await assert.rejects(generateText("groq", "test-model", "system", "prompt"), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HTTP 401/);
      assert.equal(error.message.includes("test-groq-key-123"), false);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
    setProviderCredential("groq", null);
  }
});
