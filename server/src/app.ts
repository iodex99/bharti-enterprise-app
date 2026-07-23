import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { config } from './config';
import { mountApiRoutes, mountCoreMiddleware, mountErrorHandler } from './app.core';
import { systemNodeRoutes } from './routes/system.node.routes';
import { setImageProcessor } from './platform/image';
import { nodeImageProcessor } from './platform/image.node';

/**
 * The Node/Express host: development, the automated test suite, and the optional
 * PC deployment. The Android app assembles the same routes in-process instead
 * (see app.core.ts + client/src/local/server.worker.ts).
 */
export function createApp() {
  setImageProcessor(nodeImageProcessor);

  const app = express();

  app.disable('x-powered-by');
  // Behind Cloudflare Tunnel / reverse proxies we trust the first hop for req.ip/req.secure.
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
          workerSrc: ["'self'", 'blob:'],
        },
      },
    }),
  );

  mountCoreMiddleware(app);
  mountApiRoutes(app, { systemOps: systemNodeRoutes() });

  if (config.clientDist) {
    app.use(express.static(config.clientDist, { index: false, maxAge: '1h' }));
    app.get('*splat', (_req, res) => {
      res.sendFile(path.join(config.clientDist!, 'index.html'));
    });
  }

  mountErrorHandler(app);

  return app;
}
