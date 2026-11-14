import { z } from 'zod';

export type ProviderId = 'gemini' | 'groq';
export type ProviderMode = 'automatic' | 'gemini_only' | 'groq_only';

export interface ChatTurn {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: ToolCallRequest[];
  rawParts?: unknown[];
}

export interface ToolPropertySpec {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  enum?: string[];
  items?: ToolPropertySpec;
  properties?: Record<string, ToolPropertySpec>;
  required?: string[];
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  parameters: {
    properties: Record<string, ToolPropertySpec>;
    required: string[];
  };
}

export interface ToolCallRequest {
  id: string;
  name: string;
  args: Record<string, unknown>;
  thoughtSignature?: string;
}

export interface AgentInput {
  messages: ChatTurn[];
  systemPrompt: string;
  signal?: AbortSignal;
}

export interface AgentResponse {
  provider: ProviderId;
  model: string;
  content: string;
  toolCalls: ToolCallRequest[];
  rawParts?: unknown[];
  latencyMs: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface ProviderHealth {
  provider: ProviderId;
  label: string;
  model: string;
  configured: boolean;
  healthy: boolean;
  latencyMs: number;
  lastCheckedAt: string;
  error?: string;
}

export class ProviderTransientError extends Error {
  constructor(
    public readonly provider: ProviderId,
    message: string,
    public readonly statusCode?: number
  ) {
    super(message);
    this.name = 'ProviderTransientError';
  }
}

export class ProviderConfigError extends Error {
  constructor(
    public readonly provider: ProviderId,
    message: string
  ) {
    super(message);
    this.name = 'ProviderConfigError';
  }
}

export interface AIProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly model: string;
  readonly supportsToolCalling: boolean;
  isConfigured(): boolean;
  generateWithTools(input: AgentInput, tools: AgentToolDefinition[]): Promise<AgentResponse>;
  streamWithTools(
    input: AgentInput,
    tools: AgentToolDefinition[],
    onToken: (token: string) => void
  ): Promise<AgentResponse>;
  streamText(input: AgentInput, onToken: (token: string) => void): Promise<AgentResponse>;
  generateStructured<T extends z.ZodTypeAny>(input: AgentInput, schema: T): Promise<z.infer<T>>;
  checkHealth(): Promise<ProviderHealth>;
}
