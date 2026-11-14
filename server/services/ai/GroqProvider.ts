import Groq from 'groq-sdk';
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

function convertGroqSchema(spec: ToolPropertySpec): Record<string, any> {
  const out: Record<string, any> = {
    type: spec.type,
    description: spec.description,
    ...(spec.enum ? { enum: spec.enum } : {}),
  };
  if (spec.type === 'array') {
    out.items = spec.items ? convertGroqSchema(spec.items) : { type: 'string' };
  }
  if (spec.type === 'object' && spec.properties) {
    const nested: Record<string, any> = {};
    for (const [nk, nv] of Object.entries(spec.properties)) {
      nested[nk] = convertGroqSchema(nv);
    }
    out.properties = nested;
    if (spec.required) out.required = spec.required;
  }
  return out;
}

function toGroqTools(tools: AgentToolDefinition[]) {
  return tools.map((tool) => {
    const properties: Record<string, any> = {};
    for (const [k, spec] of Object.entries(tool.parameters.properties)) {
      properties[k] = convertGroqSchema(spec);
    }
    return {
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object',
          properties,
          required: tool.parameters.required,
        },
      },
    };
  });
}

function toGroqMessages(systemPrompt: string, messages: AgentInput['messages']) {
  const out: Array<any> = [{ role: 'system', content: systemPrompt }];
  for (const msg of messages) {
    if (msg.role === 'user') {
      out.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: msg.content || null,
        ...(msg.toolCalls && msg.toolCalls.length > 0
          ? {
              tool_calls: msg.toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function',
                function: {
                  name: tc.name,
                  arguments: JSON.stringify(tc.args),
                },
              })),
            }
          : {}),
      });
    } else if (msg.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: msg.toolCallId || 'tool-call',
        content: msg.content,
      });
    }
  }
  return out;
}

function classifyGroqError(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  const status = (err as any)?.status ?? (err as any)?.statusCode;
  if (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    /429|rate_limit|timeout|ECONNRESET|ETIMEDOUT|fetch failed|503|500/i.test(msg)
  ) {
    throw new ProviderTransientError('groq', `Groq transient error: ${msg}`, Number(status) || 503);
  }
  throw new ProviderConfigError('groq', `Groq error: ${msg}`);
}

export class GroqProvider implements AIProvider {
  readonly id = 'groq' as const;
  readonly label = 'Groq Llama';
  readonly model = env.GROQ_MODEL;
  readonly supportsToolCalling = true;

  private client: Groq | null = null;

  isConfigured(): boolean {
    return Boolean(env.GROQ_API_KEY && env.GROQ_API_KEY.trim().length > 0);
  }

  private getClient(): Groq {
    if (!this.isConfigured()) {
      throw new ProviderConfigError('groq', 'GROQ_API_KEY is not configured in server secrets.');
    }
    if (!this.client) {
      this.client = new Groq({ apiKey: env.GROQ_API_KEY });
    }
    return this.client;
  }

  async generateWithTools(input: AgentInput, tools: AgentToolDefinition[]): Promise<AgentResponse> {
    const start = Date.now();
    const client = this.getClient();

    try {
      const groqTools = toGroqTools(tools);
      const completion = await client.chat.completions.create({
        model: this.model,
        messages: toGroqMessages(input.systemPrompt, input.messages),
        ...(groqTools.length > 0 ? { tools: groqTools, tool_choice: 'auto' } : {}),
      });

      const choice = completion.choices[0]?.message;
      const toolCalls: ToolCallRequest[] = (choice?.tool_calls || []).map((tc) => {
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = JSON.parse(tc.function.arguments || '{}');
        } catch {
          parsedArgs = {};
        }
        return {
          id: tc.id,
          name: tc.function.name,
          args: parsedArgs,
        };
      });

      return {
        provider: 'groq',
        model: this.model,
        content: choice?.content || '',
        toolCalls,
        latencyMs: Date.now() - start,
        usage: {
          inputTokens: completion.usage?.prompt_tokens,
          outputTokens: completion.usage?.completion_tokens,
        },
      };
    } catch (err) {
      classifyGroqError(err);
    }
  }

  async streamWithTools(
    input: AgentInput,
    tools: AgentToolDefinition[],
    onToken: (token: string) => void
  ): Promise<AgentResponse> {
    const start = Date.now();
    const client = this.getClient();

    try {
      const groqTools = toGroqTools(tools);
      const stream = await client.chat.completions.create({
        model: this.model,
        messages: toGroqMessages(input.systemPrompt, input.messages),
        ...(groqTools.length > 0 ? { tools: groqTools, tool_choice: 'auto' } : {}),
        stream: true,
      });

      let fullText = '';
      const toolMap = new Map<number, { id: string; name: string; arguments: string }>();

      for await (const chunk of stream) {
        if (input.signal?.aborted) break;
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) {
          fullText += delta.content;
          onToken(delta.content);
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const entry = toolMap.get(idx) || {
              id: tc.id || `groq-call-${Date.now()}-${idx}`,
              name: '',
              arguments: '',
            };
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name += tc.function.name;
            if (tc.function?.arguments) entry.arguments += tc.function.arguments;
            toolMap.set(idx, entry);
          }
        }
      }

      const toolCalls: ToolCallRequest[] = Array.from(toolMap.entries())
        .sort(([a], [b]) => a - b)
        .map(([, entry]) => {
          let parsedArgs: Record<string, unknown> = {};
          try {
            parsedArgs = JSON.parse(entry.arguments || '{}');
          } catch {
            parsedArgs = {};
          }
          return {
            id: entry.id,
            name: entry.name || 'unknown_tool',
            args: parsedArgs,
          };
        });

      return {
        provider: 'groq',
        model: this.model,
        content: fullText,
        toolCalls,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      classifyGroqError(err);
    }
  }

  async streamText(input: AgentInput, onToken: (token: string) => void): Promise<AgentResponse> {
    const start = Date.now();
    const client = this.getClient();

    try {
      const stream = await client.chat.completions.create({
        model: this.model,
        messages: toGroqMessages(input.systemPrompt, input.messages),
        stream: true,
      });

      let fullText = '';
      for await (const chunk of stream) {
        if (input.signal?.aborted) break;
        const delta = chunk.choices[0]?.delta?.content || '';
        if (delta) {
          fullText += delta;
          onToken(delta);
        }
      }

      return {
        provider: 'groq',
        model: this.model,
        content: fullText,
        toolCalls: [],
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      classifyGroqError(err);
    }
  }

  async generateStructured<T extends z.ZodTypeAny>(input: AgentInput, schema: T): Promise<z.infer<T>> {
    const client = this.getClient();
    try {
      const completion = await client.chat.completions.create({
        model: this.model,
        messages: toGroqMessages(input.systemPrompt, input.messages),
        response_format: { type: 'json_object' },
      });
      const raw = (completion.choices[0]?.message?.content || '{}')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim();
      return schema.parse(JSON.parse(raw || '{}'));
    } catch (err) {
      if (err instanceof z.ZodError || err instanceof SyntaxError) {
        throw new ProviderTransientError('groq', `Groq returned invalid structured JSON: ${err.message}`);
      }
      classifyGroqError(err);
    }
  }

  async checkHealth(): Promise<ProviderHealth> {
    const start = Date.now();
    const checkedAt = new Date().toISOString();
    if (!this.isConfigured()) {
      return {
        provider: 'groq',
        label: this.label,
        model: this.model,
        configured: false,
        healthy: false,
        latencyMs: 0,
        lastCheckedAt: checkedAt,
        error: 'GROQ_API_KEY not configured on server.',
      };
    }

    try {
      const client = this.getClient();
      const completion = await client.chat.completions.create({
        model: this.model,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        max_tokens: 10,
      });
      return {
        provider: 'groq',
        label: this.label,
        model: this.model,
        configured: true,
        healthy: Boolean(completion.choices[0]?.message),
        latencyMs: Date.now() - start,
        lastCheckedAt: checkedAt,
      };
    } catch (err) {
      return {
        provider: 'groq',
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
