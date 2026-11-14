import crypto from 'crypto';
import { z } from 'zod';
import { MemoryModel, TaskModel } from '../../models';
import { ToolRegistry } from './ToolRegistry';

function isSafePublicUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      host.startsWith('169.254.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function safeMathEval(expr: string): number {
  const cleaned = expr.replace(/\s+/g, '');
  if (!/^[0-9+\-*/().%^]+$/.test(cleaned)) {
    throw new Error('Expression contains unsupported characters. Use numbers and + - * / ( ) % ^ only.');
  }
  const normalized = cleaned.replace(/\^/g, '**');
  const fn = new Function(`"use strict"; return (${normalized});`);
  const val = fn();
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new Error('Expression did not evaluate to a finite number.');
  }
  return val;
}

export function createBuiltinToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register({
    name: 'workspace_calculate',
    description:
      'Evaluate a mathematical arithmetic expression accurately (supports +, -, *, /, %, ^, and parentheses).',
    riskLevel: 'low',
    schema: z.object({
      expression: z.string().min(1).max(300),
    }),
    parameters: {
      properties: {
        expression: {
          type: 'string',
          description: 'Arithmetic expression to evaluate, e.g. "(1450 * 1.15) / 12"',
        },
      },
      required: ['expression'],
    },
    async execute(input) {
      try {
        const result = safeMathEval(input.expression);
        return { success: true, data: { expression: input.expression, result } };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  registry.register({
    name: 'memory_save',
    description:
      'Save a persistent user fact, preference, or workflow rule so NEXUS remembers it in future conversations.',
    riskLevel: 'moderate',
    schema: z.object({
      key: z.string().min(1).max(80),
      value: z.string().min(1).max(500),
      category: z.enum(['preference', 'fact', 'workflow']).default('fact'),
    }),
    parameters: {
      properties: {
        key: { type: 'string', description: 'Short snake_case key, e.g. "preferred_language"' },
        value: { type: 'string', description: 'Fact or preference to remember' },
        category: {
          type: 'string',
          description: 'Category of memory',
          enum: ['preference', 'fact', 'workflow'],
        },
      },
      required: ['key', 'value'],
    },
    async execute(input, ctx) {
      const existing = await MemoryModel.findOne({
        userId: ctx.userId,
        key: new RegExp(`^${input.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
      });
      if (existing) {
        existing.value = input.value;
        existing.category = input.category;
        await existing.save();
        return {
          success: true,
          data: {
            updated: true,
            memory: { id: existing._id, key: existing.key, value: existing.value, category: existing.category },
          },
        };
      }
      const record = await MemoryModel.create({
        _id: crypto.randomUUID(),
        userId: ctx.userId,
        key: input.key,
        value: input.value,
        category: input.category,
        source: 'agent',
      });
      return {
        success: true,
        data: {
          created: true,
          memory: { id: record._id, key: record.key, value: record.value, category: record.category },
        },
      };
    },
  });

  registry.register({
    name: 'memory_search',
    description: 'Search the current user persistent memory store by keyword.',
    riskLevel: 'low',
    schema: z.object({
      query: z.string().default(''),
    }),
    parameters: {
      properties: {
        query: { type: 'string', description: 'Keyword to filter user memories (empty returns recent)' },
      },
      required: [],
    },
    async execute(input, ctx) {
      const q = input.query.trim().toLowerCase();
      const all = await MemoryModel.find({ userId: ctx.userId }).sort({ updatedAt: -1 }).lean();
      const matches = all
        .filter(
          (m: any) =>
            !q || m.key.toLowerCase().includes(q) || m.value.toLowerCase().includes(q)
        )
        .slice(0, 10)
        .map((m: any) => ({
          id: m._id,
          key: m.key,
          value: m.value,
          category: m.category,
        }));
      return { success: true, data: { count: matches.length, memories: matches } };
    },
  });

  registry.register({
    name: 'task_plan_create',
    description:
      'Create a structured, tracked execution task in the user Tasks board with ordered action steps.',
    riskLevel: 'moderate',
    schema: z.object({
      goal: z.string().min(2).max(200),
      steps: z.array(z.string().min(1)).min(1).max(10),
    }),
    parameters: {
      properties: {
        goal: { type: 'string', description: 'High-level goal of the task' },
        steps: {
          type: 'array',
          description: 'Ordered list of concrete action steps',
        },
      },
      required: ['goal', 'steps'],
    },
    async execute(input, ctx) {
      const task = await TaskModel.create({
        _id: crypto.randomUUID(),
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        goal: input.goal,
        status: 'pending',
        providerMode: 'automatic',
        activeProvider: 'gemini',
        steps: input.steps.map((s) => ({
          stepId: crypto.randomUUID(),
          action: s,
          riskLevel: 'low',
          status: 'pending',
        })),
      });
      return {
        success: true,
        data: { taskId: task._id, goal: task.goal, stepCount: task.steps.length },
      };
    },
  });

  registry.register({
    name: 'web_fetch_summary',
    description: 'Fetch a public HTTP/HTTPS webpage and return its title and clean text excerpt.',
    riskLevel: 'low',
    schema: z.object({
      url: z.string().url(),
    }),
    parameters: {
      properties: {
        url: { type: 'string', description: 'Public http:// or https:// URL to fetch' },
      },
      required: ['url'],
    },
    async execute(input) {
      if (!isSafePublicUrl(input.url)) {
        return { success: false, error: 'Blocked unsafe or non-public URL.' };
      }
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(input.url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'NEXUS-Agent/1.0' },
        });
        clearTimeout(timer);
        if (!res.ok) {
          return { success: false, error: `HTTP ${res.status} fetching URL` };
        }
        const html = await res.text();
        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 2500);
        return {
          success: true,
          data: {
            url: input.url,
            title: titleMatch?.[1]?.trim() || input.url,
            excerpt: text,
          },
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  registry.register({
    name: 'code_validate_json',
    description: 'Validate and pretty-print a JSON string, reporting exact syntax errors if invalid.',
    riskLevel: 'low',
    schema: z.object({
      jsonString: z.string().min(1),
    }),
    parameters: {
      properties: {
        jsonString: { type: 'string', description: 'Raw JSON string to validate' },
      },
      required: ['jsonString'],
    },
    async execute(input) {
      try {
        const parsed = JSON.parse(input.jsonString);
        return {
          success: true,
          data: { valid: true, formatted: JSON.stringify(parsed, null, 2) },
        };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Invalid JSON',
        };
      }
    },
  });

  return registry;
}

export const toolRegistry = createBuiltinToolRegistry();
