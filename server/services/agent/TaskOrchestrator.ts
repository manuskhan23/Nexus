import crypto from 'crypto';
import { EventEmitter } from 'events';
import { z } from 'zod';
import {
  getRedis,
  MemoryModel,
  MessageModel,
  ProviderId,
  ProviderMode,
  TaskModel,
  UserDoc,
} from '../../models';
import { providerManager } from '../ai/FailoverManager';
import { permissionEngine } from '../tools/ToolRegistry';
import { toolRegistry } from '../tools/builtinTools';
import {
  DynamicRuntimeTool,
  getDynamicConnectorToolsForUser,
  resolveDynamicToolForUser,
} from '../connectors/ConnectorService';
import { searchComposioTools } from '../connectors/ComposioBroker';
import { getActiveTrainingPromptSection } from './TrainingService';

export interface OrchestratorStep {
  stepId: string;
  action: string;
  toolName?: string;
  riskLevel: 'low' | 'moderate' | 'high';
  status:
    | 'pending'
    | 'running'
    | 'awaiting_approval'
    | 'completed'
    | 'failed'
    | 'rejected'
    | 'skipped';
  idempotencyKey: string;
  args: Record<string, unknown>;
  result?: Record<string, unknown>;
  verified: boolean;
  retries: number;
  error?: string;
  durationMs?: number;
  startedAt?: string;
  completedAt?: string;
}

const taskEvents = new EventEmitter();
taskEvents.setMaxListeners(100);

const localLocks = new Set<string>();

async function acquireTaskLock(taskId: string): Promise<boolean> {
  const redis = getRedis();
  if (redis) {
    try {
      const ok = await redis.set(`nexus:lock:task:${taskId}`, '1', 'PX', 30_000, 'NX');
      return ok === 'OK';
    } catch {
      // Fallback to local lock
    }
  }
  if (localLocks.has(taskId)) return false;
  localLocks.add(taskId);
  return true;
}

async function releaseTaskLock(taskId: string): Promise<void> {
  localLocks.delete(taskId);
  const redis = getRedis();
  if (redis) {
    try {
      await redis.del(`nexus:lock:task:${taskId}`);
    } catch {
      // Ignore release failure
    }
  }
}

export function subscribeTaskEvents(
  taskId: string,
  listener: (event: { type: string; payload: any }) => void
): () => void {
  const channel = `task:${taskId}`;
  taskEvents.on(channel, listener);
  return () => taskEvents.off(channel, listener);
}

function emitTaskEvent(taskId: string, type: string, payload: any) {
  taskEvents.emit(`task:${taskId}`, { type, payload });
}

const PlannedStepSchema = z.object({
  action: z.string().min(2).max(200),
  toolName: z.string().nullable().optional(),
  args: z.record(z.string(), z.unknown()).optional(),
});

const PlanOutputSchema = z.object({
  steps: z.array(PlannedStepSchema).min(1).max(12),
});

function serializeTask(doc: any) {
  const obj = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  const { _id, ...rest } = obj;
  return { id: _id, ...rest };
}

async function persistTaskState(task: any): Promise<void> {
  await TaskModel.findByIdAndUpdate(
    task._id,
    {
      $set: {
        status: task.status,
        currentStepIndex: task.currentStepIndex,
        activeProvider: task.activeProvider,
        finalReport: task.finalReport,
        error: task.error,
        steps: task.steps,
      },
    },
    { returnDocument: 'after' }
  );
}

async function planStepsForGoal(
  goal: string,
  user: UserDoc,
  providerMode: ProviderMode
): Promise<{ steps: OrchestratorStep[]; usedProvider: ProviderId }> {
  const [memories, training, dynamicTools] = await Promise.all([
    MemoryModel.find({ userId: user._id }).sort({ updatedAt: -1 }).limit(10).lean(),
    getActiveTrainingPromptSection(user._id, goal),
    getDynamicConnectorToolsForUser(user._id),
  ]);

  const memContext = memories
    .map((m: any) => `- ${m.key} (${m.category}): ${m.value}`)
    .join('\n');

  const allDefs = [
    ...toolRegistry.listDefinitions(),
    ...Array.from(dynamicTools.values()).map((t) => t.definition),
  ];

  const toolsDesc = allDefs
    .map(
      (t) =>
        `- ${t.name}: ${t.description.slice(0, 120)}${t.description.length > 120 ? '...' : ''} | required: [${t.parameters.required.join(', ')}]`
    )
    .join('\n');

  const systemPrompt = [
    'You are the NEXUS Multi-Step Task Planner. Decompose the user goal into an ordered JSON plan of 1 to 12 concrete steps.',
    'Return ONLY a valid JSON object matching {"steps": [{"action": string, "toolName": string | null, "args": object}]}.',
    'Available tools:',
    toolsDesc,
    'Rules:',
    '1. If a step can be executed by one of the available tools above, set toolName to that exact tool name and provide valid args matching its parameters.',
    '2. For GitHub multi-file pushes (e.g. React boilerplates), deletions, branches, merges, or PRs, prefer `composio__github__push_files`, `composio__github__delete_files`, `composio__github__branch_manager`, and `composio__github__pull_request_manager`.',
    '3. For other connected OAuth services (composio__<service>__*), if the needed action is not listed above, use composio__<service>__execute_action with {"toolSlug": "...", "argsJson": "{...}"} or composio__<service>__<ACTION_SLUG> directly.',
    '4. If a step is pure reasoning/summarization with no external tool needed, set toolName to null and args to {}.',
    '5. Keep steps minimal, ordered, and verifiable.',
    training.promptSection,
    memContext ? `\nUser Persistent Memory:\n${memContext}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const { result, usedProvider } = await providerManager.generateStructured(
    {
      systemPrompt,
      messages: [{ role: 'user', content: `Goal: ${goal}` }],
    },
    PlanOutputSchema,
    {
      mode: providerMode,
      preferred: user.preferences.preferredProvider,
      userId: user._id,
    }
  );

  const steps: OrchestratorStep[] = await Promise.all(
    result.steps.map(async (s) => {
      const builtIn = s.toolName ? toolRegistry.get(s.toolName) : undefined;
      const dyn =
        !builtIn && s.toolName
          ? await resolveDynamicToolForUser(user._id, s.toolName, dynamicTools)
          : undefined;
      const resolvedName = builtIn ? builtIn.name : dyn ? dyn.definition.name : undefined;
      const resolvedRisk = builtIn ? builtIn.riskLevel : dyn ? dyn.riskLevel : 'low';
      return {
        stepId: crypto.randomUUID(),
        action: s.action,
        toolName: resolvedName,
        riskLevel: resolvedRisk,
        status: 'pending',
        idempotencyKey: crypto.randomUUID(),
        args: (s.args as Record<string, unknown>) || {},
        verified: false,
        retries: 0,
      };
    })
  );

  return { steps, usedProvider };
}

async function attemptArgumentRecovery(
  step: OrchestratorStep,
  errorMsg: string,
  user: UserDoc,
  providerMode: ProviderMode,
  dynamicTools: Map<string, DynamicRuntimeTool>
): Promise<Record<string, unknown> | null> {
  if (!step.toolName) return null;
  const builtIn = toolRegistry.get(step.toolName);
  const dyn = builtIn
    ? undefined
    : await resolveDynamicToolForUser(user._id, step.toolName, dynamicTools);
  const spec = builtIn
    ? { name: builtIn.name, description: builtIn.description, parameters: builtIn.parameters }
    : dyn?.definition;
  if (!spec) return null;

  const RecoverySchema = z.object({
    args: z.record(z.string(), z.unknown()),
  });

  let extraHints = '';
  const composioMatch = step.toolName.match(/^(?:composio|c)__([a-zA-Z0-9_]+)__execute_action$/);
  if (composioMatch && /not found|missing|invalid/i.test(errorMsg)) {
    const toolkit = composioMatch[1].toLowerCase();
    const q = String((step.args as any)?.toolSlug || step.action || '').replace(/_/g, ' ');
    const found = await searchComposioTools(toolkit, q, 6).catch(() => []);
    if (found.length > 0) {
      extraHints = `\nCandidate exact Composio toolSlugs: ${found
        .map((f) => `${f.name} (required: ${JSON.stringify(f.inputSchema?.required || [])})`)
        .join('; ')}`;
    }
  }

  try {
    const { result } = await providerManager.generateStructured(
      {
        systemPrompt: [
          `Repair the tool arguments for "${spec.name}" (${spec.description}).`,
          `Schema properties: ${JSON.stringify(spec.parameters.properties)}`,
          `Required fields: ${JSON.stringify(spec.parameters.required)}`,
          extraHints,
          'Return JSON: {"args": {...}}',
        ]
          .filter(Boolean)
          .join('\n'),
        messages: [
          {
            role: 'user',
            content: `Previous args: ${JSON.stringify(step.args)}\nError: ${errorMsg}`,
          },
        ],
      },
      RecoverySchema,
      {
        mode: providerMode,
        preferred: user.preferences.preferredProvider,
        userId: user._id,
      }
    );
    return result.args;
  } catch {
    return null;
  }
}

async function synthesizeFinalReport(
  goal: string,
  steps: OrchestratorStep[],
  user: UserDoc,
  providerMode: ProviderMode
): Promise<{ report: string; usedProvider: ProviderId; usedModel: string }> {
  const stepSummary = steps
    .map(
      (s, i) =>
        `${i + 1}. ${s.action} [${s.status}${s.verified ? ', verified' : ''}]` +
        (s.result ? ` -> ${JSON.stringify(s.result)}` : '') +
        (s.error ? ` -> ERROR: ${s.error}` : '')
    )
    .join('\n');

  const { result, usedProvider } = await providerManager.generateWithTools(
    {
      systemPrompt:
        'Summarize the verified task execution outcomes clearly and concisely in clean Markdown (bullet points or compact columns). Never use raw HTML tags such as <br>. Report only observed step results—never invent unexecuted actions.',
      messages: [
        {
          role: 'user',
          content: `Goal: ${goal}\n\nExecuted Steps:\n${stepSummary}`,
        },
      ],
    },
    [],
    {
      mode: providerMode,
      preferred: user.preferences.preferredProvider,
      userId: user._id,
    }
  );

  return { report: result.content || stepSummary, usedProvider, usedModel: result.model };
}

async function syncLinkedMessage(task: any, activeModel?: string) {
  if (!task.messageId) return;
  const msg = await MessageModel.findOne({ _id: task.messageId, userId: task.userId });
  if (!msg) return;

  msg.content =
    task.finalReport ||
    (task.status === 'awaiting_approval'
      ? 'Multi-step execution paused awaiting your approval for the highlighted step.'
      : task.error
        ? `Task failed: ${task.error}`
        : `Task status: ${task.status}`);
  msg.provider = task.activeProvider;
  if (activeModel) {
    msg.model = activeModel;
  }
  msg.toolCalls = (task.steps as OrchestratorStep[])
    .filter((s) => Boolean(s.toolName))
    .map((s) => ({
      id: s.stepId,
      name: s.toolName!,
      riskLevel: s.riskLevel,
      status:
        s.status === 'skipped'
          ? 'rejected'
          : (s.status as any),
      args: s.args,
      result: s.result,
      error: s.error,
      durationMs: s.durationMs,
    }));
  msg.markModified('toolCalls');
  await msg.save();
}

export async function advanceTask(
  taskId: string,
  user: UserDoc,
  options: { approvedStepId?: string; lockHeld?: boolean } = {}
): Promise<any> {
  const locked = options.lockHeld ? true : await acquireTaskLock(taskId);
  if (!locked) {
    const existing = await TaskModel.findOne({ _id: taskId, userId: user._id }).lean();
    return existing ? serializeTask(existing) : null;
  }

  try {
    const task = await TaskModel.findOne({ _id: taskId, userId: user._id });
    if (!task) return null;

    if (task.status === 'cancelled') {
      return serializeTask(task);
    }

    task.status = 'running';
    await persistTaskState(task);
    emitTaskEvent(taskId, 'task_updated', serializeTask(task));

    const dynamicTools = await getDynamicConnectorToolsForUser(user._id);
    const steps = task.steps as OrchestratorStep[];

    for (let idx = task.currentStepIndex; idx < steps.length; idx++) {
      const fresh = await TaskModel.findById(taskId).lean();
      if ((fresh as any)?.status === 'cancelled') {
        return serializeTask(fresh);
      }

      const step = steps[idx];
      task.currentStepIndex = idx;

      // Idempotency guard: skip already verified completed steps
      if (step.status === 'completed' && step.verified) {
        continue;
      }

      if (step.status === 'rejected') {
        continue;
      }

      const builtInTool = step.toolName ? toolRegistry.get(step.toolName) : undefined;
      const dynamicTool =
        !builtInTool && step.toolName
          ? await resolveDynamicToolForUser(user._id, step.toolName, dynamicTools)
          : undefined;
      const resolvedTool = builtInTool || dynamicTool;

      if (resolvedTool && options.approvedStepId !== step.stepId) {
        const perm = permissionEngine.evaluate(
          { name: step.toolName!, riskLevel: resolvedTool.riskLevel } as any,
          user.preferences
        );
        if (perm.requiresApproval) {
          step.status = 'awaiting_approval';
          task.status = 'awaiting_approval';
          await persistTaskState(task);
          await syncLinkedMessage(task);
          emitTaskEvent(taskId, 'approval_required', serializeTask(task));
          return serializeTask(task);
        }
      }

      step.status = 'running';
      step.startedAt = new Date().toISOString();
      step.error = undefined;
      await persistTaskState(task);
      emitTaskEvent(taskId, 'step_started', { stepIndex: idx, task: serializeTask(task) });

      const stepStart = Date.now();

      if (!resolvedTool) {
        // Pure reasoning/checklist step
        step.status = 'completed';
        step.verified = true;
        step.result = { note: 'Step completed' };
        step.durationMs = Date.now() - stepStart;
        step.completedAt = new Date().toISOString();
        await persistTaskState(task);
        emitTaskEvent(taskId, 'step_verified', { stepIndex: idx, task: serializeTask(task) });
        continue;
      }

      let executed = false;
      while (!executed) {
        let execResult: { success: boolean; data?: any; error?: string };
        if (builtInTool) {
          const parsedArgs = builtInTool.schema.safeParse(step.args || {});
          execResult = parsedArgs.success
            ? await builtInTool.execute(parsedArgs.data, {
                userId: user._id,
                conversationId: task.conversationId,
                taskId: task._id,
              })
            : {
                success: false,
                error: `Invalid arguments: ${parsedArgs.error.issues.map((i) => i.message).join(', ')}`,
              };
        } else {
          execResult = await dynamicTool!.execute(step.args || {});
        }

        if (execResult.success) {
          step.status = 'completed';
          step.verified = true;
          step.result = execResult.data || { ok: true };
          step.error = undefined;
          step.durationMs = Date.now() - stepStart;
          step.completedAt = new Date().toISOString();
          executed = true;
        } else if (step.retries < 1) {
          step.retries += 1;
          emitTaskEvent(taskId, 'step_retrying', {
            stepIndex: idx,
            error: execResult.error,
            task: serializeTask(task),
          });
          const repairedArgs = await attemptArgumentRecovery(
            step,
            execResult.error || 'Execution error',
            user,
            task.providerMode,
            dynamicTools
          );
          if (repairedArgs) {
            step.args = repairedArgs;
            continue;
          }
          step.status = 'failed';
          step.verified = false;
          step.error = execResult.error || 'Tool execution failed';
          step.durationMs = Date.now() - stepStart;
          step.completedAt = new Date().toISOString();
          executed = true;
        } else {
          step.status = 'failed';
          step.verified = false;
          step.error = execResult.error || 'Tool execution failed';
          step.durationMs = Date.now() - stepStart;
          step.completedAt = new Date().toISOString();
          executed = true;
        }
      }

      await persistTaskState(task);

      if (step.status === 'failed') {
        task.status = 'failed';
        task.error = step.error;
        await persistTaskState(task);
        await syncLinkedMessage(task);
        emitTaskEvent(taskId, 'step_failed', serializeTask(task));
        return serializeTask(task);
      }

      emitTaskEvent(taskId, 'step_verified', { stepIndex: idx, task: serializeTask(task) });
    }

    // All steps processed -> synthesize final verified report
    const hasFailed = steps.some((s) => s.status === 'failed');
    const hasRejected = steps.some((s) => s.status === 'rejected');
    const { report, usedProvider, usedModel } = await synthesizeFinalReport(
      task.goal,
      steps,
      user,
      task.providerMode
    );

    task.activeProvider = usedProvider;
    task.finalReport = report;
    task.currentStepIndex = steps.length;
    task.status = hasFailed || hasRejected ? 'partially_completed' : 'completed';
    await persistTaskState(task);
    await syncLinkedMessage(task, usedModel);

    emitTaskEvent(taskId, 'task_completed', serializeTask(task));
    return serializeTask(task);
  } finally {
    if (!options.lockHeld) {
      await releaseTaskLock(taskId);
    }
  }
}

export async function createAndStartTask(params: {
  user: UserDoc;
  goal: string;
  providerMode: ProviderMode;
  conversationId?: string;
  messageId?: string;
}): Promise<any> {
  const { user, goal, providerMode, conversationId, messageId } = params;
  const taskId = crypto.randomUUID();

  const task = await TaskModel.create({
    _id: taskId,
    userId: user._id,
    conversationId,
    messageId,
    goal,
    status: 'planning',
    providerMode,
    activeProvider: user.preferences.preferredProvider,
    currentStepIndex: 0,
    steps: [],
  });

  emitTaskEvent(taskId, 'planning', serializeTask(task));

  try {
    const { steps, usedProvider } = await planStepsForGoal(goal, user, providerMode);
    task.steps = steps;
    task.activeProvider = usedProvider;
    task.status = 'running';
    await persistTaskState(task);
    emitTaskEvent(taskId, 'plan_ready', serializeTask(task));

    return await advanceTask(taskId, user);
  } catch (err) {
    task.status = 'failed';
    task.error = err instanceof Error ? err.message : 'Failed to plan task';
    await persistTaskState(task);
    await syncLinkedMessage(task);
    emitTaskEvent(taskId, 'task_failed', serializeTask(task));
    return serializeTask(task);
  }
}

export async function approveTaskStep(taskId: string, user: UserDoc): Promise<any> {
  const locked = await acquireTaskLock(taskId);
  if (!locked) {
    throw new Error('Task is already executing an approved step.');
  }

  try {
    const task = await TaskModel.findOne({ _id: taskId, userId: user._id });
    if (!task) return null;

    if (task.status === 'running' || task.status === 'completed') {
      return serializeTask(task);
    }

    const steps = task.steps as OrchestratorStep[];
    const pendingStep = steps.find((s) => s.status === 'awaiting_approval');
    if (!pendingStep) {
      throw new Error('No step is awaiting approval on this task.');
    }

    return await advanceTask(taskId, user, { approvedStepId: pendingStep.stepId, lockHeld: true });
  } finally {
    await releaseTaskLock(taskId);
  }
}

export async function rejectTaskStep(taskId: string, user: UserDoc): Promise<any> {
  const locked = await acquireTaskLock(taskId);
  if (!locked) {
    throw new Error('Task is currently executing an approved step and cannot be rejected now.');
  }

  try {
    const task = await TaskModel.findOne({ _id: taskId, userId: user._id });
    if (!task) return null;

    const steps = task.steps as OrchestratorStep[];
    const hasPendingApproval = steps.some((s) => s.status === 'awaiting_approval');
    if (task.status !== 'awaiting_approval' && !hasPendingApproval) {
      throw new Error(`Cannot reject task in "${task.status}" state.`);
    }

    for (const s of steps) {
      if (s.status === 'awaiting_approval' || s.status === 'pending') {
        s.status = 'rejected';
      }
    }

    const anyCompleted = steps.some((s) => s.status === 'completed');
    task.status = anyCompleted ? 'partially_completed' : 'cancelled';
    task.finalReport = anyCompleted
      ? 'Execution halted at approval gate by user. Prior verified steps were preserved.'
      : 'Task rejected by user before any state-changing steps executed.';
    await persistTaskState(task);
    await syncLinkedMessage(task);

    emitTaskEvent(taskId, 'task_cancelled', serializeTask(task));
    return serializeTask(task);
  } finally {
    await releaseTaskLock(taskId);
  }
}

export async function retryFailedTaskStep(taskId: string, user: UserDoc): Promise<any> {
  const task = await TaskModel.findOne({ _id: taskId, userId: user._id });
  if (!task) return null;

  const steps = task.steps as OrchestratorStep[];
  const failedIdx = steps.findIndex((s) => s.status === 'failed');
  if (failedIdx === -1) {
    throw new Error('No failed step found to retry.');
  }

  steps[failedIdx].status = 'pending';
  steps[failedIdx].retries = 0;
  steps[failedIdx].error = undefined;
  task.currentStepIndex = failedIdx;
  task.error = undefined;
  await persistTaskState(task);

  return advanceTask(taskId, user);
}

export async function cancelActiveTask(taskId: string, user: UserDoc): Promise<any> {
  const task = await TaskModel.findOne({ _id: taskId, userId: user._id });
  if (!task) return null;

  const steps = task.steps as OrchestratorStep[];
  for (const s of steps) {
    if (s.status === 'pending' || s.status === 'awaiting_approval' || s.status === 'running') {
      s.status = 'skipped';
    }
  }
  task.status = 'cancelled';
  task.finalReport = 'Task cancelled by user.';
  await persistTaskState(task);
  await syncLinkedMessage(task);

  emitTaskEvent(taskId, 'task_cancelled', serializeTask(task));
  return serializeTask(task);
}
