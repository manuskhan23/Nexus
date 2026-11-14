import { GoogleGenAI, FunctionDeclaration, Type, Content, Part } from '@google/genai';
import { z } from 'zod';
import { env } from '../../config/env';
import {
  AIProvider,
  AgentInput,
  AgentResponse,
  AgentToolDefinition,
  ProviderConfigError,
  ProviderHealth,
  ProviderTransientError,
  ToolCallRequest,
  ToolPropertySpec,
} from './AIProvider';

function mapType(t: ToolPropertySpec['type']): Type {
  switch (t) {
    case 'number':
      return Type.NUMBER;
    case 'boolean':
      return Type.BOOLEAN;
    case 'array':
      return Type.ARRAY;
    case 'object':
      return Type.OBJECT;
    default:
      return Type.STRING;
  }
}

function convertGeminiSchema(spec: ToolPropertySpec): Record<string, any> {
  const out: Record<string, any> = {
    type: mapType(spec.type),
    description: spec.description,
    ...(spec.enum ? { enum: spec.enum } : {}),
  };
  if (spec.type === 'array') {
    out.items = spec.items ? convertGeminiSchema(spec.items) : { type: Type.STRING };
  }
  if (spec.type === 'object' && spec.properties) {
    const nested: Record<string, any> = {};
    for (const [nk, nv] of Object.entries(spec.properties)) {
      nested[nk] = convertGeminiSchema(nv);
    }
    out.properties = nested;
    if (spec.required) out.required = spec.required;
  }
  return out;
}

function toFunctionDeclarations(tools: AgentToolDefinition[]): FunctionDeclaration[] {
  return tools.map((tool) => {
    const properties: Record<string, any> = {};
    for (const [k, spec] of Object.entries(tool.parameters.properties)) {
      properties[k] = convertGeminiSchema(spec);
    }
    const hasProps = Object.keys(properties).length > 0;
    return {
      name: tool.name,
      description: tool.description,
      ...(hasProps
        ? {
            parameters: {
              type: Type.OBJECT,
              properties,
              required: tool.parameters.required,
            },
          }
        : {}),
    };
  });
}

function toGeminiContents(messages: AgentInput['messages']): Content[] {
  const contents: Content[] = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: msg.content }] });
    } else if (msg.role === 'assistant') {
      if (msg.rawParts && msg.rawParts.length > 0) {
        contents.push({ role: 'model', parts: msg.rawParts as Part[] });
      } else {
        const parts: Part[] = [];
        if (msg.content) parts.push({ text: msg.content });
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          for (const tc of msg.toolCalls) {
            parts.push({
              functionCall: {
                id: tc.id,
                name: tc.name,
                args: tc.args,
              },
              thoughtSignature: tc.thoughtSignature || 'skip_thought_signature_validator',
            });
          }
        }
        if (parts.length > 0) {
          contents.push({ role: 'model', parts });
        }
      }
    } else if (msg.role === 'tool' && msg.toolName) {
      const hasNativeId = Boolean(msg.toolCallId && !msg.toolCallId.startsWith('gemini-call-'));
      const fnPart: Part = {
        functionResponse: {
          ...(hasNativeId ? { id: msg.toolCallId } : {}),
          name: msg.toolName,
          response: { output: msg.content },
        },
      };
      const prev = contents[contents.length - 1];
      if (
        prev &&
        prev.role === 'user' &&
        Array.isArray(prev.parts) &&
        prev.parts.length > 0 &&
        prev.parts.every((p) => Boolean(p.functionResponse))
      ) {
        prev.parts.push(fnPart);
      } else {
        contents.push({
          role: 'user',
          parts: [fnPart],
        });
      }
    }
  }
  return contents;
}

const FALLBACK_GEMINI_MODEL = 'gemini-3.1-flash-lite';

function isTransientGeminiError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const status =
    (err as any)?.status ??
    (err as any)?.code ??
    (err as any)?.error?.code;
  const errStatus = (err as any)?.error?.status;
  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    errStatus === 'UNAVAILABLE' ||
    errStatus === 'RESOURCE_EXHAUSTED' ||
    /429|RESOURCE_EXHAUSTED|UNAVAILABLE|high demand|timeout|ECONNRESET|ETIMEDOUT|fetch failed|503|500/i.test(
      msg
    )
  );
}

function classifyGeminiError(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  const status =
    (err as any)?.status ??
    (err as any)?.code ??
    (err as any)?.error?.code;
  if (isTransientGeminiError(err)) {
    throw new ProviderTransientError('gemini', `Gemini transient error: ${msg}`, Number(status) || 503);
  }
  throw new ProviderConfigError('gemini', `Gemini error: ${msg}`);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ProviderTransientError('gemini', `Gemini ${label} timeout after ${ms}ms`, 504));
    }, ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

class NonRetryableStreamError extends Error {
  constructor(public readonly originalError: unknown) {
    super(originalError instanceof Error ? originalError.message : String(originalError));
  }
}

export class GeminiProvider implements AIProvider {
  readonly id = 'gemini' as const;
  readonly label = 'Google Gemini';
  readonly model = env.GEMINI_MODEL;
  readonly supportsToolCalling = true;

  private client: GoogleGenAI | null = null;
  private primaryCooldownUntil = 0;

  isConfigured(): boolean {
    return Boolean(env.GEMINI_API_KEY && env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY');
  }

  private getClient(): GoogleGenAI {
    if (!this.isConfigured()) {
      throw new ProviderConfigError('gemini', 'GEMINI_API_KEY is not configured in server secrets.');
    }
    if (!this.client) {
      this.client = new GoogleGenAI({
        apiKey: env.GEMINI_API_KEY,
        httpOptions: {
          timeout: 45_000,
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });
    }
    return this.client;
  }

  private async iterateStreamWithTimeout<TChunk>(
    createStream: () => Promise<AsyncIterable<TChunk>>,
    firstChunkTimeoutMs: number,
    idleChunkTimeoutMs: number,
    onChunk: (chunk: TChunk) => void,
    hasEmitted: () => boolean,
    signal?: AbortSignal
  ): Promise<void> {
    const stream = await withTimeout(createStream(), firstChunkTimeoutMs, 'stream connect');
    const iterator = stream[Symbol.asyncIterator]();
    let isFirst = true;

    try {
      while (true) {
        if (signal?.aborted) break;
        const timeoutMs = isFirst ? firstChunkTimeoutMs : idleChunkTimeoutMs;
        const nextStep = await withTimeout(
          iterator.next(),
          timeoutMs,
          isFirst ? 'first token' : 'stream idle'
        );
        if (nextStep.done) break;
        isFirst = false;
        onChunk(nextStep.value);
      }
    } catch (err) {
      if (hasEmitted()) {
        throw new NonRetryableStreamError(err);
      }
      throw err;
    } finally {
      if (typeof iterator.return === 'function') {
        void iterator.return().catch(() => undefined);
      }
    }
  }

  private async executeWithTransientFallback<T>(
    fn: (modelName: string, timeoutMs: number) => Promise<T>,
    signal?: AbortSignal
  ): Promise<{ data: T; modelUsed: string }> {
    if (this.model !== FALLBACK_GEMINI_MODEL && Date.now() < this.primaryCooldownUntil) {
      try {
        const data = await fn(FALLBACK_GEMINI_MODEL, 32_000);
        return { data, modelUsed: FALLBACK_GEMINI_MODEL };
      } catch (err) {
        if (err instanceof NonRetryableStreamError) {
          classifyGeminiError(err.originalError);
        }
        classifyGeminiError(err);
      }
    }

    try {
      const timeoutMs = this.model !== FALLBACK_GEMINI_MODEL ? 12_000 : 32_000;
      const data = await fn(this.model, timeoutMs);
      return { data, modelUsed: this.model };
    } catch (firstErr) {
      if (firstErr instanceof NonRetryableStreamError) {
        classifyGeminiError(firstErr.originalError);
      }
      if (!isTransientGeminiError(firstErr) || signal?.aborted) {
        classifyGeminiError(firstErr);
      }

      if (this.model === FALLBACK_GEMINI_MODEL) {
        classifyGeminiError(firstErr);
      }

      // Put overloaded primary model on cooldown for 5 minutes and immediately use lite fallback
      this.primaryCooldownUntil = Date.now() + 300_000;
      try {
        const fallbackData = await fn(FALLBACK_GEMINI_MODEL, 32_000);
        return { data: fallbackData, modelUsed: FALLBACK_GEMINI_MODEL };
      } catch (fallbackErr) {
        if (fallbackErr instanceof NonRetryableStreamError) {
          classifyGeminiError(fallbackErr.originalError);
        }
        classifyGeminiError(fallbackErr);
      }
    }
  }

  async generateWithTools(input: AgentInput, tools: AgentToolDefinition[]): Promise<AgentResponse> {
    const start = Date.now();
    const ai = this.getClient();
    const declarations = toFunctionDeclarations(tools);

    const { data: response, modelUsed } = await this.executeWithTransientFallback(
      (modelName, timeoutMs) =>
        withTimeout(
          ai.models.generateContent({
            model: modelName,
            contents: toGeminiContents(input.messages),
            config: {
              systemInstruction: input.systemPrompt,
              ...(declarations.length > 0 ? { tools: [{ functionDeclarations: declarations }] } : {}),
            },
          }),
          timeoutMs,
          modelName
        ),
      input.signal
    );

    const candidateParts = response.candidates?.[0]?.content?.parts || [];
    const fnCallParts = candidateParts.filter((p) => Boolean(p.functionCall));
    const toolCalls: ToolCallRequest[] =
      fnCallParts.length > 0
        ? fnCallParts.map((p, idx) => ({
            id: p.functionCall!.id || `gemini-call-${Date.now()}-${idx}`,
            name: p.functionCall!.name || 'unknown_tool',
            args: (p.functionCall!.args as Record<string, unknown>) || {},
            ...(p.thoughtSignature ? { thoughtSignature: p.thoughtSignature } : {}),
          }))
        : (response.functionCalls || []).map((fc, idx) => ({
            id: fc.id || `gemini-call-${Date.now()}-${idx}`,
            name: fc.name || 'unknown_tool',
            args: (fc.args as Record<string, unknown>) || {},
          }));

    return {
      provider: 'gemini',
      model: modelUsed,
      content: response.text || '',
      toolCalls,
      ...(candidateParts.length > 0 ? { rawParts: candidateParts } : {}),
      latencyMs: Date.now() - start,
      usage: {
        inputTokens: response.usageMetadata?.promptTokenCount,
        outputTokens: response.usageMetadata?.candidatesTokenCount,
      },
    };
  }

  async streamWithTools(
    input: AgentInput,
    tools: AgentToolDefinition[],
    onToken: (token: string) => void
  ): Promise<AgentResponse> {
    const start = Date.now();
    const ai = this.getClient();
    const declarations = toFunctionDeclarations(tools);

    const { data, modelUsed } = await this.executeWithTransientFallback(async (modelName, firstChunkTimeoutMs) => {
      let fullText = '';
      let emittedAny = false;
      const toolCalls: ToolCallRequest[] = [];
      const rawParts: Part[] = [];
      let usage: { inputTokens?: number; outputTokens?: number } | undefined;

      await this.iterateStreamWithTimeout(
        () =>
          ai.models.generateContentStream({
            model: modelName,
            contents: toGeminiContents(input.messages),
            config: {
              systemInstruction: input.systemPrompt,
              ...(declarations.length > 0 ? { tools: [{ functionDeclarations: declarations }] } : {}),
            },
          }),
        firstChunkTimeoutMs,
        25_000,
        (chunk) => {
          if (chunk.usageMetadata) {
            usage = {
              inputTokens: chunk.usageMetadata.promptTokenCount,
              outputTokens: chunk.usageMetadata.candidatesTokenCount,
            };
          }

          const parts = chunk.candidates?.[0]?.content?.parts || [];
          if (parts.length > 0) {
            for (const p of parts) {
              if (p.functionCall) {
                emittedAny = true;
                toolCalls.push({
                  id: p.functionCall.id || `gemini-call-${Date.now()}-${toolCalls.length}`,
                  name: p.functionCall.name || 'unknown_tool',
                  args: (p.functionCall.args as Record<string, unknown>) || {},
                  ...(p.thoughtSignature ? { thoughtSignature: p.thoughtSignature } : {}),
                });
                rawParts.push(p);
              } else if (typeof p.text === 'string' && p.text.length > 0) {
                if ((p as any).thought) {
                  rawParts.push(p);
                } else {
                  emittedAny = true;
                  fullText += p.text;
                  onToken(p.text);

                  const lastPart = rawParts[rawParts.length - 1];
                  if (
                    lastPart &&
                    typeof lastPart.text === 'string' &&
                    !(lastPart as any).thought &&
                    !lastPart.functionCall &&
                    !lastPart.thoughtSignature &&
                    !p.thoughtSignature
                  ) {
                    lastPart.text += p.text;
                  } else {
                    rawParts.push({ ...p });
                  }
                }
              } else {
                rawParts.push(p);
              }
            }
          } else {
            const delta = chunk.text || '';
            if (delta) {
              emittedAny = true;
              fullText += delta;
              onToken(delta);
              const lastPart = rawParts[rawParts.length - 1];
              if (lastPart && typeof lastPart.text === 'string' && !lastPart.functionCall) {
                lastPart.text += delta;
              } else {
                rawParts.push({ text: delta });
              }
            }
          }
        },
        () => emittedAny,
        input.signal
      );

      return { fullText, toolCalls, rawParts, usage };
    }, input.signal);

    return {
      provider: 'gemini',
      model: modelUsed,
      content: data.fullText,
      toolCalls: data.toolCalls,
      ...(data.rawParts.length > 0 ? { rawParts: data.rawParts } : {}),
      latencyMs: Date.now() - start,
      ...(data.usage ? { usage: data.usage } : {}),
    };
  }

  async streamText(input: AgentInput, onToken: (token: string) => void): Promise<AgentResponse> {
    const start = Date.now();
    const ai = this.getClient();

    const { data: fullText, modelUsed } = await this.executeWithTransientFallback(
      async (modelName, firstChunkTimeoutMs) => {
        let text = '';
        let emittedAny = false;

        await this.iterateStreamWithTimeout(
          () =>
            ai.models.generateContentStream({
              model: modelName,
              contents: toGeminiContents(input.messages),
              config: {
                systemInstruction: input.systemPrompt,
              },
            }),
          firstChunkTimeoutMs,
          25_000,
          (chunk) => {
            const delta = chunk.text || '';
            if (delta) {
              emittedAny = true;
              text += delta;
              onToken(delta);
            }
          },
          () => emittedAny,
          input.signal
        );

        return text;
      },
      input.signal
    );

    return {
      provider: 'gemini',
      model: modelUsed,
      content: fullText,
      toolCalls: [],
      latencyMs: Date.now() - start,
    };
  }

  async generateStructured<T extends z.ZodTypeAny>(input: AgentInput, schema: T): Promise<z.infer<T>> {
    const ai = this.getClient();
    const { data: response } = await this.executeWithTransientFallback(
      (modelName, timeoutMs) =>
        withTimeout(
          ai.models.generateContent({
            model: modelName,
            contents: toGeminiContents(input.messages),
            config: {
              systemInstruction: input.systemPrompt,
              responseMimeType: 'application/json',
            },
          }),
          timeoutMs,
          modelName
        ),
      input.signal
    );

    try {
      const raw = (response.text || '{}').trim();
      return schema.parse(JSON.parse(raw));
    } catch (err) {
      if (err instanceof z.ZodError || err instanceof SyntaxError) {
        throw new ProviderTransientError('gemini', `Gemini returned invalid structured JSON: ${err.message}`);
      }
      classifyGeminiError(err);
    }
  }

  async checkHealth(): Promise<ProviderHealth> {
    const start = Date.now();
    const checkedAt = new Date().toISOString();
    if (!this.isConfigured()) {
      return {
        provider: 'gemini',
        label: this.label,
        model: this.model,
        configured: false,
        healthy: false,
        latencyMs: 0,
        lastCheckedAt: checkedAt,
        error: 'GEMINI_API_KEY not configured on server.',
      };
    }

    try {
      const ai = this.getClient();
      const { data: response, modelUsed } = await this.executeWithTransientFallback((modelName, timeoutMs) =>
        withTimeout(
          ai.models.generateContent({
            model: modelName,
            contents: 'Reply with OK.',
          }),
          timeoutMs,
          modelName
        )
      );
      return {
        provider: 'gemini',
        label: this.label,
        model: modelUsed,
        configured: true,
        healthy: Boolean(response.text !== undefined),
        latencyMs: Date.now() - start,
        lastCheckedAt: checkedAt,
      };
    } catch (err) {
      return {
        provider: 'gemini',
        label: this.label,
        model: this.model,
        configured: true,
        healthy: false,
        latencyMs: Date.now() - start,
        lastCheckedAt: checkedAt,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
