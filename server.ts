import cookieParser from 'cookie-parser';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { env } from './server/config/env';
import { connectInfrastructure } from './server/models';
import authRoutes from './server/routes/authRoutes';
import connectorRoutes from './server/routes/connectorRoutes';
import conversationRoutes from './server/routes/conversationRoutes';
import providerRoutes from './server/routes/providerRoutes';
import trainingRoutes from './server/routes/trainingRoutes';
import workspaceRoutes from './server/routes/workspaceRoutes';

async function bootstrap() {
  const infra = await connectInfrastructure();

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'nexus',
      mongodb: infra.mongoConnected ? 'connected' : 'disconnected',
      redis: infra.redisConnected ? 'connected' : 'disconnected',
      timestamp: new Date().toISOString(),
    });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/connectors', connectorRoutes);
  app.use('/api/conversations', conversationRoutes);
  app.use('/api/providers', providerRoutes);
  app.use('/api/training', trainingRoutes);
  app.use('/api', workspaceRoutes);

  if (env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true, allowedHosts: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
  }

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('Unhandled server error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  app.listen(env.PORT, '0.0.0.0', () => {
    console.log(`NEXUS server running on http://localhost:${env.PORT}`);
  });
}

bootstrap().catch((err) => {
  console.error('Failed to start NEXUS server:', err);
  process.exit(1);
});
