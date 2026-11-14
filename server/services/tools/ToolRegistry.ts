import { z } from 'zod';
import { AgentToolDefinition, ToolPropertySpec } from '../ai/AIProvider';
import { UserDoc } from '../../models';

export type RiskLevel = 'low' | 'moderate' | 'high';

export interface ToolContext {
  userId: string;
  conversationId?: string;
  taskId?: string;
}

export interface ToolExecutionResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

export interface NexusTool<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  riskLevel: RiskLevel;
  schema: TSchema;
  parameters: {
    properties: Record<string, ToolPropertySpec>;
    required: string[];
  };
  execute: (input: z.infer<TSchema>, ctx: ToolContext) => Promise<ToolExecutionResult>;
}

export class PermissionEngine {
  evaluate(tool: NexusTool, preferences: UserDoc['preferences']): {
    requiresApproval: boolean;
    reason?: string;
  } {
    if (tool.riskLevel === 'high') {
      return {
        requiresApproval: true,
        reason: `Tool "${tool.name}" is classified as high-risk and requires explicit confirmation.`,
      };
    }
    if (tool.riskLevel === 'moderate' && preferences.requireApprovalForModerate) {
      return {
        requiresApproval: true,
        reason: `Your workspace policy requires confirmation before running "${tool.name}".`,
      };
    }
    if (tool.riskLevel === 'low' && !preferences.autoExecuteLowRisk) {
      return {
        requiresApproval: true,
        reason: `Automatic low-risk execution is disabled in your workspace settings.`,
      };
    }
    return { requiresApproval: false };
  }
}

export class ToolRegistry {
  private tools = new Map<string, NexusTool>();

  register<T extends z.ZodTypeAny>(tool: NexusTool<T>): void {
    this.tools.set(tool.name, tool as unknown as NexusTool);
  }

  get(name: string): NexusTool | undefined {
    return this.tools.get(name);
  }

  listDefinitions(): AgentToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  listMetadata() {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      riskLevel: t.riskLevel,
    }));
  }
}

export const permissionEngine = new PermissionEngine();
