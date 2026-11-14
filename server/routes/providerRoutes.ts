import { Router } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest, requireAuth } from '../middleware/auth';
import { ProviderLogModel } from '../models';
import { providerManager } from '../services/ai/FailoverManager';
import { toolRegistry } from '../services/tools/builtinTools';

const router = Router();
router.use(requireAuth);

function mapDoc(doc: any) {
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

router.get('/status', async (_req: AuthenticatedRequest, res) => {
  const gemini = providerManager.getProvider('gemini');
  const groq = providerManager.getProvider('groq');
  const recentLogs = await ProviderLogModel.find().sort({ createdAt: -1 }).limit(25).lean();
  res.json({
    providers: [
      {
        id: gemini.id,
        label: gemini.label,
        model: gemini.model,
        configured: gemini.isConfigured(),
        supportsToolCalling: gemini.supportsToolCalling,
      },
      {
        id: groq.id,
        label: groq.label,
        model: groq.model,
        configured: groq.isConfigured(),
        supportsToolCalling: groq.supportsToolCalling,
      },
    ],
    simulatedOutage: providerManager.getSimulatedOutage(),
    tools: toolRegistry.listMetadata(),
    recentLogs: recentLogs.map(mapDoc),
  });
});

router.post('/health', async (req: AuthenticatedRequest, res) => {
  const health = await providerManager.checkAllHealth(req.userId);
  const recentLogs = await ProviderLogModel.find().sort({ createdAt: -1 }).limit(25).lean();
  res.json({ health, recentLogs: recentLogs.map(mapDoc) });
});

router.post('/simulate-outage', (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    provider: z.enum(['gemini', 'groq']).nullable(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid outage target' });
    return;
  }
  providerManager.setSimulatedOutage(parsed.data.provider);
  res.json({ simulatedOutage: providerManager.getSimulatedOutage() });
});

router.post('/test-routing', async (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    prompt: z.string().trim().min(1).max(2000),
    mode: z.enum(['automatic', 'gemini_only', 'groq_only']).default('automatic'),
    enableTools: z.boolean().default(true),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Prompt is required' });
    return;
  }

  try {
    const tools = parsed.data.enableTools ? toolRegistry.listDefinitions() : [];
    const { result, usedProvider, switched } = await providerManager.generateWithTools(
      {
        systemPrompt: 'You are NEXUS provider diagnostics. Answer concisely or invoke a tool if asked.',
        messages: [{ role: 'user', content: parsed.data.prompt }],
      },
      tools,
      {
        mode: parsed.data.mode,
        preferred: req.user!.preferences.preferredProvider,
        userId: req.userId,
      }
    );

    const recentLogs = await ProviderLogModel.find().sort({ createdAt: -1 }).limit(25).lean();
    res.json({
      usedProvider,
      model: result.model,
      latencyMs: result.latencyMs,
      switched: switched || null,
      content: result.content,
      toolCalls: result.toolCalls,
      recentLogs: recentLogs.map(mapDoc),
    });
  } catch (err) {
    const recentLogs = await ProviderLogModel.find().sort({ createdAt: -1 }).limit(25).lean();
    res.status(502).json({
      error: err instanceof Error ? err.message : 'Provider routing test failed',
      recentLogs: recentLogs.map(mapDoc),
    });
  }
});

export default router;
