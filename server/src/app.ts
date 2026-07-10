import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { config } from './config';
import { attachUser, checkOrigin } from './middleware/auth';
import { systemRoutes } from './routes/system.routes';
import { authRoutes } from './routes/auth.routes';
import { usersRoutes } from './routes/users.routes';
import { auditRoutes } from './routes/audit.routes';
import { mastersRoutes } from './routes/masters.routes';
import { uploadsRoutes, uploadsStatic } from './routes/uploads.routes';
import { purchasesRoutes } from './routes/purchases.routes';
import { stockRoutes } from './routes/stock.routes';
import { openingRoutes } from './routes/opening.routes';
import { cuttingRoutes } from './routes/cutting.routes';
import { contractorsRoutes, jobsRoutes } from './routes/jobs.routes';
import { checkingRoutes, dispatchesRoutes, packingRoutes } from './routes/checking.routes';
import { reportsRoutes, traceRoutes } from './routes/reports.routes';
import { dashboardRoutes } from './routes/dashboard.routes';

export function createApp() {
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
        },
      },
    }),
  );
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  app.use(checkOrigin);
  app.use(attachUser);

  app.use('/api/system', systemRoutes());
  app.use('/api/auth', authRoutes());
  app.use('/api/users', usersRoutes());
  app.use('/api/audit', auditRoutes());
  app.use('/api/masters', mastersRoutes());
  app.use('/api/uploads', uploadsRoutes());
  app.use('/uploads', uploadsStatic());
  app.use('/api/purchases', purchasesRoutes());
  app.use('/api/stock', stockRoutes());
  app.use('/api/opening-balances', openingRoutes());
  app.use('/api/cutting', cuttingRoutes());
  app.use('/api/jobs', jobsRoutes());
  app.use('/api/contractors', contractorsRoutes());
  app.use('/api/checking', checkingRoutes());
  app.use('/api/packing', packingRoutes());
  app.use('/api/dispatches', dispatchesRoutes());
  app.use('/api/reports', reportsRoutes());
  app.use('/api/trace', traceRoutes());
  app.use('/api/dashboard', dashboardRoutes());

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
