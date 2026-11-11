import { randomUUID } from "node:crypto";

export type ToolRisk = "low" | "medium" | "high";

export interface ToolContext {
  projectId: string;
  approved: boolean;
  signal: AbortSignal;
}

export interface ToolDefinition<Input, Output> {
  id: string;
  name: string;
  description: string;
  risk: ToolRisk;
  timeoutMs: number;
  validate(input: unknown): Input;
  execute(input: Input, context: ToolContext): Promise<Output>;
}

export interface ToolExecutionEvent {
  id: string;
  toolId: string;
  projectId: string;
  status: "started" | "completed" | "failed";
  at: string;
  durationMs?: number;
  error?: string;
}

export interface ToolExecutionResult<Output> {
  id: string;
  toolId: string;
  result: Output;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export class ToolApprovalRequiredError extends Error {
  constructor(toolId: string) {
    super(`Tool ${toolId} requires explicit user approval`);
    this.name = "ToolApprovalRequiredError";
  }
}

export class ToolRegistry {
  private readonly definitions = new Map<string, ToolDefinition<unknown, unknown>>();
  private readonly eventSink?: (event: ToolExecutionEvent) => Promise<void> | void;

  constructor(eventSink?: (event: ToolExecutionEvent) => Promise<void> | void) {
    this.eventSink = eventSink;
  }

  register<Input, Output>(definition: ToolDefinition<Input, Output>): void {
    if (!/^[a-z][a-z0-9_.-]{1,80}$/.test(definition.id)) throw new Error("Invalid tool identifier");
    if (!definition.name.trim() || !definition.description.trim()) throw new Error("Tool name and description are required");
    if (!["low", "medium", "high"].includes(definition.risk)) throw new Error("Invalid tool risk");
    if (!Number.isInteger(definition.timeoutMs) || definition.timeoutMs < 100 || definition.timeoutMs > 10 * 60_000) {
      throw new Error("Tool timeout must be between 100 ms and 10 minutes");
    }
    if (this.definitions.has(definition.id)) throw new Error(`Tool is already registered: ${definition.id}`);
    this.definitions.set(definition.id, definition as ToolDefinition<unknown, unknown>);
  }

  list(): Array<Pick<ToolDefinition<unknown, unknown>, "id" | "name" | "description" | "risk" | "timeoutMs">> {
    return Array.from(this.definitions.values()).map(({ id, name, description, risk, timeoutMs }) => ({
      id, name, description, risk, timeoutMs
    }));
  }

  async execute<Output>(
    toolId: string,
    rawInput: unknown,
    context: Omit<ToolContext, "signal">
  ): Promise<ToolExecutionResult<Output>> {
    const definition = this.definitions.get(toolId);
    if (!definition) throw new Error(`Tool is not registered: ${toolId}`);
    if (definition.risk !== "low" && context.approved !== true) throw new ToolApprovalRequiredError(toolId);
    if (!context.projectId || context.projectId.length > 64) throw new Error("Invalid tool project context");

    const input = definition.validate(rawInput);
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const controller = new AbortController();
    const eventBase = { id, toolId, projectId: context.projectId };
    await this.eventSink?.({ ...eventBase, status: "started", at: startedAt });

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort(new Error("Tool execution timed out"));
          reject(new Error(`Tool execution timed out after ${definition.timeoutMs} ms`));
        }, definition.timeoutMs);
      });
      const result = await Promise.race([
        definition.execute(input, { ...context, signal: controller.signal }),
        timeout
      ]) as Output;
      const completedAt = new Date().toISOString();
      const durationMs = Date.now() - started;
      await this.eventSink?.({ ...eventBase, status: "completed", at: completedAt, durationMs });
      return { id, toolId, result, startedAt, completedAt, durationMs };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tool execution failed";
      await this.eventSink?.({
        ...eventBase,
        status: "failed",
        at: new Date().toISOString(),
        durationMs: Date.now() - started,
        error: message.replace(/(?:password|secret|api[_-]?key|token)\s*[:=]\s*[^\s,;]+/gi, "$1[redacted]").slice(0, 500)
      });
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
