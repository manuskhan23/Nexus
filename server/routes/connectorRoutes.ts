import { Router } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest, requireAuth } from '../middleware/auth';
import { ConnectorModel } from '../models';
import {
  CONNECTOR_CATALOG,
  completeConnectorOAuth,
  getOAuthCapabilities,
  invokeSavedConnector,
  retestSavedConnector,
  sanitizeConnectorDoc,
  saveVerifiedConnector,
  startConnectorOAuth,
  testConnectorDraft,
} from '../services/connectors/ConnectorService';

const router = Router();

function renderOAuthPopupHtml(payload: { ok: boolean; connector?: any; error?: string }) {
  const serialized = JSON.stringify(
    payload.ok
      ? { type: 'NEXUS_OAUTH_SUCCESS', connector: payload.connector }
      : { type: 'NEXUS_OAUTH_ERROR', error: payload.error || 'OAuth authorization failed' }
  ).replace(/</g, '\\u003c');

  const heading = payload.ok ? 'Authorization Verified' : 'Authorization Failed';
  const detail = payload.ok
    ? `${payload.connector?.name || 'Connector'} has been verified and saved to NEXUS. Closing this window...`
    : String(payload.error || 'Unable to verify connection.');

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${heading} — NEXUS</title></head>
<body style="font-family: system-ui, -apple-system, sans-serif; padding: 32px; background: #09090b; color: #f4f4f5;">
  <div style="max-width: 440px; margin: 40px auto; border: 1px solid #27272a; border-radius: 12px; padding: 24px; background: #18181b;">
    <h2 style="margin: 0 0 8px; font-size: 18px;">${heading}</h2>
    <p style="margin: 0 0 16px; font-size: 14px; color: #a1a1aa; line-height: 1.5;">${detail.replace(/</g, '&lt;')}</p>
    <button onclick="window.close()" style="padding: 8px 16px; border-radius: 8px; border: 1px solid #3f3f46; background: #27272a; color: #fff; cursor: pointer;">Close Window</button>
  </div>
  <script>
    (function () {
      var msg = ${serialized};
      try {
        if (window.opener) {
          window.opener.postMessage(msg, '*');
          if (msg.type === 'NEXUS_OAUTH_SUCCESS') {
            setTimeout(function () { window.close(); }, 600);
          }
        }
      } catch (e) {}
    })();
  </script>
</body>
</html>`;
}

// Public browser OAuth callback (authenticated via HMAC-signed state)
router.get(['/oauth/callback', '/oauth/callback/'], async (req, res) => {
  try {
    const connector = await completeConnectorOAuth(req.query as Record<string, any>);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderOAuthPopupHtml({ ok: true, connector }));
  } catch (err) {
    res.status(400).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(
      renderOAuthPopupHtml({
        ok: false,
        error: err instanceof Error ? err.message : 'OAuth verification failed',
      })
    );
  }
});

router.use(requireAuth);

router.get('/oauth/status', async (req: AuthenticatedRequest, res) => {
  const origin = typeof req.query.origin === 'string' ? req.query.origin : undefined;
  res.json(getOAuthCapabilities(origin));
});

router.post('/oauth/start', async (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    mode: z.enum(['auto', 'composio', 'direct_oauth', 'mcp_oauth']).optional(),
    slug: z.string().trim().optional(),
    name: z.string().trim().max(100).optional(),
    mcpUrl: z.string().trim().max(500).optional(),
    origin: z.string().trim().max(300).optional(),
    clientId: z.string().trim().max(500).optional(),
    clientSecret: z.string().trim().max(1000).optional(),
    domain: z.string().trim().max(300).optional(),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid OAuth start payload' });
    return;
  }

  try {
    const out = await startConnectorOAuth(req.userId!, parsed.data);
    res.json(out);
  } catch (err: any) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Unable to start OAuth flow',
      needsConfiguration: Boolean(err?.needsConfiguration),
      callbackUrl: err?.callbackUrl,
      envKeyHint: err?.envKeyHint,
      setupDocsUrl: err?.setupDocsUrl,
    });
  }
});

const DraftSchema = z.object({
  kind: z.enum(['catalog', 'custom_api', 'mcp_server']),
  slug: z.string().trim().optional(),
  name: z.string().trim().max(100).optional(),
  description: z.string().trim().max(400).optional(),
  baseUrl: z.string().trim().max(500).optional(),
  healthPath: z.string().trim().max(300).optional(),
  authType: z.enum(['bearer', 'api_key_header', 'basic', 'webhook', 'none']).optional(),
  authHeaderName: z.string().trim().max(100).optional(),
  token: z.string().trim().max(4000).optional(),
  secondaryToken: z.string().trim().max(1000).optional(),
  domain: z.string().trim().max(300).optional(),
  customHeaders: z.record(z.string(), z.string()).optional(),
  verificationProof: z.string().optional(),
});

router.get('/catalog', async (req: AuthenticatedRequest, res) => {
  const saved = await ConnectorModel.find({ userId: req.userId }).sort({ updatedAt: -1 }).lean();
  res.json({
    catalog: CONNECTOR_CATALOG,
    connections: saved.map(sanitizeConnectorDoc),
  });
});

router.post('/test', async (req: AuthenticatedRequest, res) => {
  const parsed = DraftSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, message: 'Invalid connector test payload' });
    return;
  }

  const result = await testConnectorDraft(req.userId!, parsed.data);
  res.status(result.ok ? 200 : 400).json(result);
});

router.post('/', async (req: AuthenticatedRequest, res) => {
  const parsed = DraftSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid connector payload' });
    return;
  }

  try {
    const connector = await saveVerifiedConnector(req.userId!, parsed.data);
    res.status(201).json({ connector });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Connector verification failed before saving',
    });
  }
});

router.post('/:id/test', async (req: AuthenticatedRequest, res) => {
  const result = await retestSavedConnector(req.userId!, req.params.id);
  if (!result) {
    res.status(404).json({ error: 'Connector not found' });
    return;
  }
  res.json(result);
});

router.post('/:id/invoke', async (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    toolName: z.string().optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
    path: z.string().optional(),
    body: z.unknown().optional(),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid invoke payload' });
    return;
  }

  const out = await invokeSavedConnector(req.userId!, req.params.id, parsed.data);
  res.status(out.ok ? 200 : 400).json(out);
});

router.patch('/:id', async (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    active: z.boolean().optional(),
    name: z.string().trim().min(1).max(100).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid connector update' });
    return;
  }

  const doc = await ConnectorModel.findOne({ _id: req.params.id, userId: req.userId });
  if (!doc) {
    res.status(404).json({ error: 'Connector not found' });
    return;
  }

  if (typeof parsed.data.active === 'boolean') doc.active = parsed.data.active;
  if (parsed.data.name) doc.name = parsed.data.name;
  await doc.save();

  res.json({ connector: sanitizeConnectorDoc(doc) });
});

router.delete('/:id', async (req: AuthenticatedRequest, res) => {
  const deleted = await ConnectorModel.findOneAndDelete({
    _id: req.params.id,
    userId: req.userId,
  });
  if (!deleted) {
    res.status(404).json({ error: 'Connector not found' });
    return;
  }
  res.json({ deleted: true });
});

export default router;
