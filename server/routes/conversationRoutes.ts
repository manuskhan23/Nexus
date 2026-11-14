import crypto from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest, requireAuth } from '../middleware/auth';
import { ConversationModel, MessageModel } from '../models';
import { runAgentTurn } from '../services/agent/AgentRunner';
import { createAndStartTask } from '../services/agent/TaskOrchestrator';
import { executeTrainingCommand } from '../services/agent/TrainingService';

const router = Router();
router.use(requireAuth);

function mapDoc(doc: any) {
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

router.get('/', async (req: AuthenticatedRequest, res) => {
  const docs = await ConversationModel.find({ userId: req.userId })
    .sort({ lastMessageAt: -1 })
    .limit(50)
    .lean();
  res.json({ conversations: docs.map(mapDoc) });
});

router.post('/', async (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    title: z.string().trim().min(1).max(140).optional(),
    providerMode: z.enum(['automatic', 'gemini_only', 'groq_only']).optional(),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid conversation payload' });
    return;
  }

  const user = req.user!;
  const conv = await ConversationModel.create({
    _id: crypto.randomUUID(),
    userId: user._id,
    title: parsed.data.title || 'New Conversation',
    providerMode: parsed.data.providerMode || user.preferences.defaultProviderMode,
    activeProvider: user.preferences.preferredProvider,
    messageCount: 0,
    lastMessageAt: new Date(),
  });

  res.status(201).json({ conversation: mapDoc(conv.toObject()) });
});

router.patch('/:id', async (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    title: z.string().trim().min(1).max(140).optional(),
    providerMode: z.enum(['automatic', 'gemini_only', 'groq_only']).optional(),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid update payload' });
    return;
  }

  const conv = await ConversationModel.findOne({ _id: req.params.id, userId: req.userId });
  if (!conv) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }

  if (parsed.data.title) conv.title = parsed.data.title;
  if (parsed.data.providerMode) conv.providerMode = parsed.data.providerMode;
  await conv.save();
  res.json({ conversation: mapDoc(conv.toObject()) });
});

router.delete('/:id', async (req: AuthenticatedRequest, res) => {
  const deleted = await ConversationModel.findOneAndDelete({
    _id: req.params.id,
    userId: req.userId,
  });
  if (!deleted) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  await MessageModel.deleteMany({ conversationId: req.params.id, userId: req.userId });
  res.json({ deleted: true });
});

router.get('/:id/messages', async (req: AuthenticatedRequest, res) => {
  const conv = await ConversationModel.findOne({
    _id: req.params.id,
    userId: req.userId,
  }).lean();
  if (!conv) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }

  const messages = await MessageModel.find({
    conversationId: conv._id,
    userId: req.userId,
  })
    .sort({ createdAt: 1 })
    .lean();

  res.json({ conversation: mapDoc(conv), messages: messages.map(mapDoc) });
});

router.post('/:id/stream', async (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    content: z.string().trim().min(1).max(100_000),
    providerMode: z.enum(['automatic', 'gemini_only', 'groq_only']).optional(),
    executionMode: z.enum(['chat', 'task']).default('chat'),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Message content is required' });
    return;
  }

  const conv = await ConversationModel.findOne({ _id: req.params.id, userId: req.userId });
  if (!conv) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }

  const mode = parsed.data.providerMode || conv.providerMode;
  conv.providerMode = mode;

  const userMsgDoc = await MessageModel.create({
    _id: crypto.randomUUID(),
    conversationId: conv._id,
    userId: req.userId!,
    role: 'user',
    content: parsed.data.content,
    toolCalls: [],
  });

  if (conv.messageCount === 0 && conv.title === 'New Conversation') {
    conv.title = parsed.data.content.slice(0, 64);
  }
  conv.messageCount += 1;
  conv.lastMessageAt = new Date();
  await conv.save();

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const abortController = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) {
      abortController.abort();
    }
  });

  const sendEvent = (event: string, data: unknown) => {
    if (!res.writableEnded) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };

  sendEvent('user_message', mapDoc(userMsgDoc.toObject()));

  if (parsed.data.content.trim().startsWith('/')) {
    const cmdStart = Date.now();
    const assistantMsgId = crypto.randomUUID();
    sendEvent('meta', {
      messageId: assistantMsgId,
      provider: req.user!.preferences.preferredProvider,
      mode,
    });

    try {
      const cmdResult = await executeTrainingCommand({
        user: req.user!,
        rawCommand: parsed.data.content,
        conversationId: conv._id,
      });

      sendEvent('token', { token: cmdResult.replyMarkdown });

      const savedCmdMsg = await MessageModel.create({
        _id: assistantMsgId,
        conversationId: conv._id,
        userId: req.userId!,
        role: 'assistant',
        content: cmdResult.replyMarkdown,
        provider: req.user!.preferences.preferredProvider,
        model: 'nexus-command-trainer',
        latencyMs: Date.now() - cmdStart,
        toolCalls: [],
      });

      conv.messageCount += 1;
      conv.lastMessageAt = new Date();
      await conv.save();

      sendEvent('done', { message: mapDoc(savedCmdMsg.toObject()) });
      res.end();
    } catch (err) {
      sendEvent('error', {
        error: err instanceof Error ? err.message : 'Command execution failed',
      });
      res.end();
    }
    return;
  }

  if (parsed.data.executionMode === 'task') {
    const assistantMsgId = crypto.randomUUID();
    const assistantMsg = await MessageModel.create({
      _id: assistantMsgId,
      conversationId: conv._id,
      userId: req.userId!,
      role: 'assistant',
      content: 'Planning multi-step task...',
      provider: req.user!.preferences.preferredProvider,
      toolCalls: [],
    });

    sendEvent('meta', {
      messageId: assistantMsgId,
      provider: req.user!.preferences.preferredProvider,
      mode,
    });

    const task = await createAndStartTask({
      user: req.user!,
      goal: parsed.data.content,
      providerMode: mode,
      conversationId: conv._id,
      messageId: assistantMsgId,
    });

    assistantMsg.taskId = task.id;
    await assistantMsg.save();

    const updatedMsg = await MessageModel.findById(assistantMsgId).lean();
    conv.activeProvider = task.activeProvider;
    conv.messageCount += 1;
    conv.lastMessageAt = new Date();
    await conv.save();

    sendEvent('task_attached', { task, message: updatedMsg ? mapDoc(updatedMsg) : null });
    sendEvent('done', {
      message: updatedMsg ? mapDoc(updatedMsg) : mapDoc(assistantMsg.toObject()),
    });
    res.end();
    return;
  }

  await runAgentTurn({
    user: req.user!,
    conversationId: conv._id,
    providerMode: mode,
    preferredProvider: req.user!.preferences.preferredProvider,
    signal: abortController.signal,
    callbacks: {
      onMeta: (info) => sendEvent('meta', info),
      onProviderSwitch: (evt) => sendEvent('provider_switch', evt),
      onToolUpdate: (trace) => sendEvent('tool_update', trace),
      onToken: (token) => sendEvent('token', { token }),
      onStreamReset: () => sendEvent('stream_reset', {}),
      onDone: (message) => {
        sendEvent('done', { message });
        res.end();
      },
      onError: (error) => {
        sendEvent('error', { error });
        res.end();
      },
    },
  });
});

export default router;
