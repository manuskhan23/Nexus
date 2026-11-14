import crypto from 'crypto';
import {
  ConversationModel,
  MemoryModel,
  MessageModel,
  ProviderId,
  ProviderMode,
  TaskModel,
  UserDoc,
} from '../../models';
import { ChatTurn } from '../ai/AIProvider';
import { FailoverEvent, providerManager } from '../ai/FailoverManager';
import { permissionEngine } from '../tools/ToolRegistry';
import { toolRegistry } from '../tools/builtinTools';
import {
  getDynamicConnectorToolsForUser,
  resolveDynamicToolForUser,
} from '../connectors/ConnectorService';
import { getActiveTrainingPromptSection, recordToolErrorLesson } from './TrainingService';

export interface ToolCallTrace {
  id: string;
  name: string;
  riskLevel: 'low' | 'moderate' | 'high';
  status: 'pending' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'rejected';
  args: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
  durationMs?: number;
}

export interface StreamCallbacks {
  onMeta: (info: { messageId: string; provider: ProviderId; mode: ProviderMode }) => void;
  onProviderSwitch: (evt: FailoverEvent) => void;
  onToolUpdate: (trace: ToolCallTrace) => void;
  onToken: (token: string) => void;
  onStreamReset?: () => void;
  onDone: (message: any) => void;
  onError: (message: string) => void;
}

async function buildSystemPrompt(user: UserDoc, queryContext?: string): Promise<string> {
  const [userMemories, training] = await Promise.all([
    MemoryModel.find({ userId: user._id }).sort({ updatedAt: -1 }).limit(12).lean(),
    getActiveTrainingPromptSection(user._id, queryContext),
  ]);

  const memLines = userMemories
    .map((m: any) => `- [${m.category}] ${m.key}: ${m.value}`)
    .join('\n');

  return [
    'You are NEXUS, an autonomous digital assistant that thinks clearly, uses tools accurately, and reports verified results.',
    'Never fabricate tool execution results—only report outcomes returned by actual tool calls.',
    'When a task requires arithmetic, memory lookup/saving, structured task planning, JSON validation, reading a public webpage, or calling a connected service / MCP server tool, call the appropriate tool.',
    'For connected GitHub accounts: prefer `composio__github__push_files` to push one or multiple files (such as a full React boilerplate) to any branch in one commit (auto-creates missing branches, accepts plain UTF-8 code), `composio__github__delete_files` to delete files, `composio__github__branch_manager` to create/delete/merge/list branches, and `composio__github__pull_request_manager` to create/merge/close/list PRs.',
    'For other connected OAuth services or GitHub actions (composio__<service>__*), if a needed action is not in the initial tool list, call composio__<service>__search_tools to find its exact toolSlug and parameters, then run it via composio__<service>__execute_action.',
    'If the user makes a factual, syntax, or logic mistake, gently point it out and apply the corrected approach going forward.',
    training.promptSection,
    memLines ? `\nUser Persistent Memory:\n${memLines}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export async function runAgentTurn(params: {
  user: UserDoc;
  conversationId: string;
  providerMode: ProviderMode;
  preferredProvider: ProviderId;
  signal?: AbortSignal;
  callbacks: StreamCallbacks;
}): Promise<void> {
  const { user, conversationId, providerMode, preferredProvider, signal, callbacks } = params;
  const start = Date.now();

  const recentDocs = await MessageModel.find({
    conversationId,
    userId: user._id,
  })
    .sort({ createdAt: -1 })
    .limit(16)
    .lean();

  const history: ChatTurn[] = recentDocs.reverse().map((m: any) => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.content,
  }));

  const assistantMsgId = crypto.randomUUID();
  const toolTraces: ToolCallTrace[] = [];
  let content = '';
  let taskId: string | undefined;

  callbacks.onMeta({
    messageId: assistantMsgId,
    provider: preferredProvider,
    mode: providerMode,
  });

  const latestUserPrompt =
    [...history].reverse().find((m) => m.role === 'user')?.content || '';

  const [systemPrompt, dynamicTools] = await Promise.all([
    buildSystemPrompt(user, latestUserPrompt),
    getDynamicConnectorToolsForUser(user._id),
  ]);
  const tools = [
    ...toolRegistry.listDefinitions(),
    ...Array.from(dynamicTools.values()).map((t) => t.definition),
  ];
  const workingTurns: ChatTurn[] = [...history];
  let activeProvider: ProviderId = preferredProvider;
  let activeModel = providerManager.getProvider(preferredProvider).model;
  let switchedEvent: FailoverEvent | undefined;

  try {
    for (let hop = 0; hop < 8; hop++) {
      if (signal?.aborted) break;

      let hopEmittedTokens = false;
      const { result, usedProvider, switched } = await providerManager.streamWithTools(
        { messages: workingTurns, systemPrompt, signal },
        tools,
        (tok) => {
          hopEmittedTokens = true;
          callbacks.onToken(tok);
        },
        {
          mode: providerMode,
          preferred: activeProvider,
          userId: user._id,
          onSwitch: (evt) => {
            switchedEvent = evt;
            callbacks.onProviderSwitch(evt);
          },
        }
      );

      activeProvider = usedProvider;
      activeModel = result.model;
      if (switched) switchedEvent = switched;

      if (result.toolCalls.length === 0) {
        content = result.content;
        if (!hopEmittedTokens && result.content) {
          callbacks.onToken(result.content);
        }
        break;
      }

      if (hopEmittedTokens) {
        callbacks.onStreamReset?.();
      }

      workingTurns.push({
        role: 'assistant',
        content: result.content || '',
        toolCalls: result.toolCalls,
        ...(result.rawParts ? { rawParts: result.rawParts } : {}),
      });

      let pausedForApproval = false;
      const pendingApprovalSteps: Array<{
        stepId: string;
        action: string;
        toolName: string;
        riskLevel: 'low' | 'moderate' | 'high';
        status: 'awaiting_approval' | 'pending';
        idempotencyKey: string;
        args: Record<string, unknown>;
        verified: boolean;
        retries: number;
      }> = [];

      for (const tc of result.toolCalls) {
        const builtInTool = toolRegistry.get(tc.name);
        const dynamicTool = builtInTool
          ? undefined
          : await resolveDynamicToolForUser(user._id, tc.name, dynamicTools);
        const resolvedTool = builtInTool || dynamicTool;

        if (!resolvedTool) {
          const errTrace: ToolCallTrace = {
            id: tc.id,
            name: tc.name,
            riskLevel: 'low',
            status: 'failed',
            args: tc.args,
            error: `Unknown tool: ${tc.name}`,
          };
          toolTraces.push(errTrace);
          callbacks.onToolUpdate(errTrace);
          workingTurns.push({
            role: 'tool',
            toolCallId: tc.id,
            toolName: tc.name,
            content: JSON.stringify({ success: false, error: errTrace.error }),
          });
          continue;
        }

        const riskLevel = resolvedTool.riskLevel;
        const perm = permissionEngine.evaluate(
          { name: tc.name, riskLevel } as any,
          user.preferences
        );
        if (perm.requiresApproval) {
          const isFirstPending = pendingApprovalSteps.length === 0;
          const pendingTrace: ToolCallTrace = {
            id: tc.id,
            name: tc.name,
            riskLevel,
            status: isFirstPending ? 'awaiting_approval' : 'pending',
            args: tc.args,
          };
          toolTraces.push(pendingTrace);
          callbacks.onToolUpdate(pendingTrace);

          pendingApprovalSteps.push({
            stepId: tc.id,
            action: `Execute tool "${tc.name}"`,
            toolName: tc.name,
            riskLevel,
            status: isFirstPending ? 'awaiting_approval' : 'pending',
            idempotencyKey: crypto.randomUUID(),
            args: tc.args,
            verified: false,
            retries: 0,
          });
          pausedForApproval = true;
          continue;
        }

        const runningTrace: ToolCallTrace = {
          id: tc.id,
          name: tc.name,
          riskLevel,
          status: 'running',
          args: tc.args,
        };
        callbacks.onToolUpdate(runningTrace);

        const toolStart = Date.now();
        let execResult: { success: boolean; data?: any; error?: string };
        if (builtInTool) {
          const parsedArgs = builtInTool.schema.safeParse(tc.args);
          execResult = parsedArgs.success
            ? await builtInTool.execute(parsedArgs.data, {
                userId: user._id,
                conversationId,
              })
            : {
                success: false,
                error: `Invalid arguments: ${parsedArgs.error.issues.map((i) => i.message).join(', ')}`,
              };
        } else {
          execResult = await dynamicTool!.execute(tc.args);
        }

        const finalTrace: ToolCallTrace = {
          id: tc.id,
          name: tc.name,
          riskLevel,
          status: execResult.success ? 'completed' : 'failed',
          args: tc.args,
          result: execResult.data,
          error: execResult.error,
          durationMs: Date.now() - toolStart,
        };
        toolTraces.push(finalTrace);
        callbacks.onToolUpdate(finalTrace);

        if (!execResult.success && execResult.error && user.preferences.autoLearnFromErrors !== false) {
          void recordToolErrorLesson({
            userId: user._id,
            toolName: tc.name,
            args: tc.args,
            error: execResult.error,
            conversationId,
          }).catch(() => undefined);
        }

        workingTurns.push({
          role: 'tool',
          toolCallId: tc.id,
          toolName: tc.name,
          content: JSON.stringify(execResult),
        });
      }

      if (pausedForApproval && pendingApprovalSteps.length > 0) {
        const createdTask = await TaskModel.create({
          _id: crypto.randomUUID(),
          userId: user._id,
          conversationId,
          messageId: assistantMsgId,
          goal:
            pendingApprovalSteps.length === 1
              ? `Approve ${pendingApprovalSteps[0].toolName} execution`
              : `Approve ${pendingApprovalSteps.length} actions (${pendingApprovalSteps.map((s) => s.toolName).join(', ')})`,
          status: 'awaiting_approval',
          providerMode,
          activeProvider,
          currentStepIndex: 0,
          steps: pendingApprovalSteps,
        });
        taskId = createdTask._id;

        const notice =
          'Execution paused: one or more actions require your explicit approval before running. Review the tool request below to approve or reject.';
        content = notice;
        callbacks.onToken(notice);
        break;
      }

      if (hop === 7 && !content) {
        const { result: finalStream, usedProvider: finalProv } = await providerManager.streamText(
          { messages: workingTurns, systemPrompt, signal },
          (tok) => callbacks.onToken(tok),
          {
            mode: providerMode,
            preferred: activeProvider,
            userId: user._id,
          }
        );
        content = finalStream.content;
        activeProvider = finalProv;
        activeModel = finalStream.model;
      }
    }

    const latencyMs = Date.now() - start;
    const savedDoc = await MessageModel.create({
      _id: assistantMsgId,
      conversationId,
      userId: user._id,
      role: 'assistant',
      content,
      provider: activeProvider,
      model: activeModel,
      latencyMs,
      ...(switchedEvent ? { providerSwitched: switchedEvent } : {}),
      toolCalls: toolTraces,
      ...(taskId ? { taskId } : {}),
    });

    await ConversationModel.updateOne(
      { _id: conversationId, userId: user._id },
      {
        $set: { activeProvider, lastMessageAt: new Date() },
        $inc: { messageCount: 1 },
      }
    );

    callbacks.onDone({
      id: savedDoc._id,
      conversationId: savedDoc.conversationId,
      userId: savedDoc.userId,
      role: savedDoc.role,
      content: savedDoc.content,
      provider: savedDoc.provider,
      model: savedDoc.model,
      latencyMs: savedDoc.latencyMs,
      providerSwitched: savedDoc.providerSwitched,
      toolCalls: savedDoc.toolCalls,
      taskId: savedDoc.taskId,
      createdAt: savedDoc.createdAt,
    });
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : 'AI provider execution failed.';
    callbacks.onError(errMessage);
  }
}
