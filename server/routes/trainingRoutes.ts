import { Router } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest, requireAuth } from '../middleware/auth';
import { MessageModel, TrainingLessonModel } from '../models';
import {
  SUPPORTED_TRAINING_COMMANDS,
  analyzeConversationErrors,
  distillLessonFromError,
  executeTrainingCommand,
  executeTrainingCommandBatch,
  recordOrReinforceLesson,
} from '../services/agent/TrainingService';

const router = Router();
router.use(requireAuth);

function mapDoc(doc: any) {
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

router.get('/lessons', async (req: AuthenticatedRequest, res) => {
  const lessons = await TrainingLessonModel.find({ userId: req.userId })
    .sort({ active: -1, confidence: -1, updatedAt: -1 })
    .limit(250)
    .lean();

  res.json({
    lessons: lessons.map(mapDoc),
    commands: SUPPORTED_TRAINING_COMMANDS,
  });
});

router.post('/lessons', async (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    triggerPattern: z.string().trim().min(2).max(120),
    mistakeSummary: z.string().trim().min(2).max(400),
    learnedRule: z.string().trim().min(4).max(500),
    exampleCorrection: z.string().trim().max(500).optional(),
    source: z.enum(['user_correction', 'ai_error', 'tool_error', 'command']).default('command'),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid training rule payload' });
    return;
  }

  const result = await recordOrReinforceLesson({
    userId: req.userId!,
    source: parsed.data.source,
    triggerPattern: parsed.data.triggerPattern,
    mistakeSummary: parsed.data.mistakeSummary,
    learnedRule: parsed.data.learnedRule,
    exampleCorrection: parsed.data.exampleCorrection,
  });

  res.status(201).json(result);
});

router.patch('/lessons/:id', async (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    active: z.boolean().optional(),
    reinforce: z.boolean().optional(),
    triggerPattern: z.string().trim().min(2).max(120).optional(),
    mistakeSummary: z.string().trim().min(2).max(400).optional(),
    learnedRule: z.string().trim().min(4).max(500).optional(),
    exampleCorrection: z.string().trim().max(500).optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid lesson update payload' });
    return;
  }

  const doc = await TrainingLessonModel.findOne({ _id: req.params.id, userId: req.userId });
  if (!doc) {
    res.status(404).json({ error: 'Training lesson not found' });
    return;
  }

  const d = parsed.data;
  if (typeof d.active === 'boolean') doc.active = d.active;
  if (d.reinforce) doc.confidence = Math.min(20, (doc.confidence || 1) + 1);
  if (d.triggerPattern) doc.triggerPattern = d.triggerPattern;
  if (d.mistakeSummary) doc.mistakeSummary = d.mistakeSummary;
  if (d.learnedRule) doc.learnedRule = d.learnedRule;
  if (typeof d.exampleCorrection === 'string') doc.exampleCorrection = d.exampleCorrection;

  await doc.save();
  res.json({ lesson: mapDoc(doc.toObject()) });
});

router.delete('/lessons/:id', async (req: AuthenticatedRequest, res) => {
  const deleted = await TrainingLessonModel.findOneAndDelete({
    _id: req.params.id,
    userId: req.userId,
  });
  if (!deleted) {
    res.status(404).json({ error: 'Training lesson not found' });
    return;
  }
  res.json({ deleted: true });
});

router.post('/feedback', async (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    messageId: z.string().min(1),
    rating: z.enum(['good', 'error']),
    note: z.string().trim().max(1200).optional(),
    errorOrigin: z.enum(['ai_error', 'user_correction']).default('ai_error'),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid feedback payload' });
    return;
  }

  const msg = await MessageModel.findOne({ _id: parsed.data.messageId, userId: req.userId });
  if (!msg) {
    res.status(404).json({ error: 'Message not found' });
    return;
  }

  if (parsed.data.rating === 'good') {
    msg.feedback = {
      rating: 'good',
      note: parsed.data.note || 'Marked helpful',
      updatedAt: new Date(),
    };
    await msg.save();
    res.json({ message: mapDoc(msg.toObject()), lesson: null });
    return;
  }

  if (!parsed.data.note || parsed.data.note.length < 3) {
    res.status(400).json({ error: 'Please explain what went wrong so NEXUS can learn from it.' });
    return;
  }

  // Find adjacent context message in the conversation
  const neighborMessages = await MessageModel.find({
    conversationId: msg.conversationId,
    userId: req.userId,
    createdAt: msg.role === 'assistant' ? { $lte: msg.createdAt } : { $gte: msg.createdAt },
  })
    .sort({ createdAt: msg.role === 'assistant' ? -1 : 1 })
    .limit(3)
    .lean();

  let userPrompt = msg.role === 'user' ? String(msg.content || '') : '';
  let assistantResponse = msg.role === 'assistant' ? String(msg.content || '') : '';
  for (const m of neighborMessages) {
    if (!userPrompt && m.role === 'user') userPrompt = String(m.content || '');
    if (!assistantResponse && m.role === 'assistant') assistantResponse = String(m.content || '');
  }

  const { lesson, reinforced } = await distillLessonFromError({
    user: req.user!,
    source: parsed.data.errorOrigin,
    userPrompt,
    assistantResponse,
    correctionNote: parsed.data.note,
    conversationId: msg.conversationId,
    messageId: msg._id,
  });

  msg.feedback = {
    rating: 'error',
    note: parsed.data.note,
    lessonId: lesson.id,
    updatedAt: new Date(),
  };
  await msg.save();

  res.json({ message: mapDoc(msg.toObject()), lesson, reinforced });
});

router.post('/analyze-conversation', async (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    conversationId: z.string().min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'conversationId is required' });
    return;
  }

  const result = await analyzeConversationErrors({
    user: req.user!,
    conversationId: parsed.data.conversationId,
  });
  res.json(result);
});

router.post('/command', async (req: AuthenticatedRequest, res) => {
  const optionalCommandText = z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().trim().min(1).max(500_000).optional()
  );
  const schema = z.object({
    command: optionalCommandText,
    script: optionalCommandText,
    conversationId: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues[0]?.message || 'Invalid training command payload.',
    });
    return;
  }
  if (!parsed.data.command && !parsed.data.script) {
    res.status(400).json({ error: 'Provide a command or multi-line cmds script.' });
    return;
  }

  if (parsed.data.script) {
    const results = await executeTrainingCommandBatch({
      user: req.user!,
      script: parsed.data.script,
      conversationId: parsed.data.conversationId,
    });
    res.json({ batch: true, results });
    return;
  }

  const raw = parsed.data.command!.startsWith('/')
    ? parsed.data.command!
    : `/train ${parsed.data.command!}`;
  const result = await executeTrainingCommand({
    user: req.user!,
    rawCommand: raw,
    conversationId: parsed.data.conversationId,
  });
  res.json({ batch: false, result });
});

export default router;
