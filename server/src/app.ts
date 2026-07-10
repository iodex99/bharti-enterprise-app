import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { config } from './config';
import { systemRoutes } from './routes/system.routes';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  // Behind Cloudflare Tunnel / reverse proxies we trust the first hop for req.ip.
  app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'"],
        },
      },
    }),
  );
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());

  app.use('/api/system', systemRoutes());

  // Unknown API routes are a JSON 404, not the SPA fallback.
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  if (config.clientDist) {
    app.use(express.static(config.clientDist, { index: false, maxAge: '1h' }));
    app.get('*splat', (_req, res) => {
      res.sendFile(path.join(config.clientDist!, 'index.html'));
    });
  }

  // Central error handler — Express 5 forwards async throws here automatically.
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[error]', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
