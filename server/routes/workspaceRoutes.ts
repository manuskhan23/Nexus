import crypto from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest, requireAuth } from '../middleware/auth';
import { ConversationModel, MemoryModel, TaskModel } from '../models';
import { providerManager } from '../services/ai/FailoverManager';
import {
  approveTaskStep,
  cancelActiveTask,
  createAndStartTask,
  rejectTaskStep,
  retryFailedTaskStep,
  subscribeTaskEvents,
} from '../services/agent/TaskOrchestrator';

const router = Router();
router.use(requireAuth);

function mapDoc(doc: any) {
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

router.get('/dashboard/summary', async (req: AuthenticatedRequest, res) => {
  const userId = req.userId!;
  const [conversations, tasks, memoriesCount, conversationsCount] = await Promise.all([
    ConversationModel.find({ userId }).sort({ lastMessageAt: -1 }).limit(5).lean(),
    TaskModel.find({ userId }).sort({ updatedAt: -1 }).lean(),
    MemoryModel.countDocuments({ userId }),
    ConversationModel.countDocuments({ userId }),
  ]);

  res.json({
    counts: {
      conversations: conversationsCount,
      tasksTotal: tasks.length,
      tasksAwaitingApproval: tasks.filter((t: any) => t.status === 'awaiting_approval').length,
      memories: memoriesCount,
    },
    providers: {
      geminiConfigured: providerManager.getProvider('gemini').isConfigured(),
      groqConfigured: providerManager.getProvider('groq').isConfigured(),
      simulatedOutage: providerManager.getSimulatedOutage(),
    },
    recentConversations: conversations.map(mapDoc),
    recentTasks: tasks.slice(0, 5).map(mapDoc),
  });
});

router.get('/tasks', async (req: AuthenticatedRequest, res) => {
  const tasks = await TaskModel.find({ userId: req.userId }).sort({ updatedAt: -1 }).lean();
  res.json({ tasks: tasks.map(mapDoc) });
});

router.get('/tasks/:id', async (req: AuthenticatedRequest, res) => {
  const task = await TaskModel.findOne({ _id: req.params.id, userId: req.userId }).lean();
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  res.json({ task: mapDoc(task) });
});

router.post('/tasks/run', async (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    goal: z.string().trim().min(3, 'Goal must be at least 3 characters').max(2000),
    providerMode: z.enum(['automatic', 'gemini_only', 'groq_only']).optional(),
    conversationId: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid task payload' });
    return;
  }

  const mode = parsed.data.providerMode || req.user!.preferences.defaultProviderMode;
  const task = await createAndStartTask({
    user: req.user!,
    goal: parsed.data.goal,
    providerMode: mode,
    conversationId: parsed.data.conversationId,
  });

  res.status(201).json({ task });
});

router.get('/tasks/:id/stream', async (req: AuthenticatedRequest, res) => {
  const task = await TaskModel.findOne({ _id: req.params.id, userId: req.userId }).lean();
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event: string, data: unknown) => {
    if (!res.writableEnded) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };

  send('snapshot', mapDoc(task));

  const unsubscribe = subscribeTaskEvents(req.params.id, ({ type, payload }) => {
    send(type, payload);
  });

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

router.post('/tasks/:id/approve', async (req: AuthenticatedRequest, res) => {
  try {
    const task = await approveTaskStep(req.params.id, req.user!);
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    res.json({ task });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Unable to approve task' });
  }
});

router.post('/tasks/:id/reject', async (req: AuthenticatedRequest, res) => {
  try {
    const task = await rejectTaskStep(req.params.id, req.user!);
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    res.json({ task });
  } catch (err) {
    res.status(409).json({ error: err instanceof Error ? err.message : 'Unable to reject task' });
  }
});

router.post('/tasks/:id/retry', async (req: AuthenticatedRequest, res) => {
  try {
    const task = await retryFailedTaskStep(req.params.id, req.user!);
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    res.json({ task });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Unable to retry task' });
  }
});

router.post('/tasks/:id/cancel', async (req: AuthenticatedRequest, res) => {
  try {
    const task = await cancelActiveTask(req.params.id, req.user!);
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    res.json({ task });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Unable to cancel task' });
  }
});

router.get('/memories', async (req: AuthenticatedRequest, res) => {
  const memories = await MemoryModel.find({ userId: req.userId }).sort({ updatedAt: -1 }).lean();
  res.json({ memories: memories.map(mapDoc) });
});

router.post('/memories', async (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    key: z.string().trim().min(1).max(80),
    value: z.string().trim().min(1).max(500),
    category: z.enum(['preference', 'fact', 'workflow']).default('fact'),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Key and value are required' });
    return;
  }

  const record = await MemoryModel.create({
    _id: crypto.randomUUID(),
    userId: req.userId!,
    key: parsed.data.key,
    value: parsed.data.value,
    category: parsed.data.category,
    source: 'user',
  });
  res.status(201).json({ memory: mapDoc(record.toObject()) });
});

router.delete('/memories/:id', async (req: AuthenticatedRequest, res) => {
  const deleted = await MemoryModel.findOneAndDelete({
    _id: req.params.id,
    userId: req.userId,
  });
  if (!deleted) {
    res.status(404).json({ error: 'Memory not found' });
    return;
  }
  res.json({ deleted: true });
});

export default router;
