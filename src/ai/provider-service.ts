export type AIProviderId = "gemini" | "groq";

export interface ProviderStatus {
  id: AIProviderId;
  configured: boolean;
}

const credentials = new Map<AIProviderId, string>();
const PROVIDER_TIMEOUT_MS = 45_000;
const MAX_PROMPT_CHARS = 30_000;
const MAX_RESPONSE_CHARS = 32_000;

export function setProviderCredential(provider: AIProviderId, credential: string | null): void {
  if (provider !== "gemini" && provider !== "groq") throw new Error("Unsupported AI provider");
  if (credential !== null && (credential.trim().length < 8 || credential.length > 4096)) {
    throw new Error("Provider credential must contain between 8 and 4096 characters");
  }
  if (credential === null) credentials.delete(provider);
  else credentials.set(provider, credential.trim());
}

export function getProviderStatuses(): ProviderStatus[] {
  return (["gemini", "groq"] as const).map((id) => ({ id, configured: credentials.has(id) }));
}

export async function generateText(
  provider: AIProviderId,
  model: string,
  systemPrompt: string,
  prompt: string
): Promise<{ provider: AIProviderId; model: string; text: string }> {
  if (provider !== "gemini" && provider !== "groq") throw new Error("Unsupported AI provider");
  const credential = credentials.get(provider);
  if (!credential) throw new Error(`${provider} credentials are not configured`);
  if (typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(model)) {
    throw new Error("A valid provider model identifier is required");
  }
  if (systemPrompt.length > MAX_PROMPT_CHARS || prompt.length > MAX_PROMPT_CHARS ||
      systemPrompt.length + prompt.length > MAX_PROMPT_CHARS) {
    throw new Error("AI prompts exceed the 30000 character limit");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    let response: Response;
    if (provider === "gemini") {
      const endpoint = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`);
      response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": credential },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 4096, temperature: 0.2 }
        }),
        signal: controller.signal
      });
    } else {
      response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
        body: JSON.stringify({
          model,
          messages: [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }],
          max_completion_tokens: 4096,
          temperature: 0.2
        }),
        signal: controller.signal
      });
    }
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      const safeText = errorText.replace(/(?:key|token|secret)\s*[:=]\s*[^\s,"]+/gi, "$1=[redacted]").slice(0, 300);
      throw new Error(`${provider} request failed (HTTP ${response.status})${safeText ? `: ${safeText}` : ""}`);
    }
    const payload: unknown = await response.json();
    const text = provider === "gemini"
      ? extractGeminiText(payload)
      : extractGroqText(payload);
    if (!text.trim()) throw new Error(`${provider} returned an empty response`);
    if (text.length > MAX_RESPONSE_CHARS) throw new Error("AI response exceeded the 32000 character limit");
    return { provider, model, text };
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${provider} request timed out after 45 seconds`);
    const message = error instanceof Error ? error.message : "Provider request failed";
    if (message.includes("request failed") || message.includes("returned an empty") || message.includes("exceeded")) throw error;
    throw new Error(`${provider} request could not be completed`);
  } finally {
    clearTimeout(timer);
  }
}

function extractGeminiText(payload: unknown): string {
  if (!payload || typeof payload !== "object") throw new Error("Gemini returned an invalid response");
  const candidates = (payload as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) throw new Error("Gemini returned no text candidates");
  const parts = (candidates[0] as { content?: { parts?: unknown } } | undefined)?.content?.parts;
  if (!Array.isArray(parts)) throw new Error("Gemini returned no text parts");
  return parts.map((part) => part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
    ? (part as { text: string }).text : "").join("");
}

function extractGroqText(payload: unknown): string {
  if (!payload || typeof payload !== "object") throw new Error("Groq returned an invalid response");
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) throw new Error("Groq returned no text choices");
  const text = (choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content;
  if (typeof text !== "string") throw new Error("Groq returned no text content");
  return text;
}
