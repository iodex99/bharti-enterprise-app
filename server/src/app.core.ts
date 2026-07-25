import express, { type Router } from 'express';
import cookieParser from 'cookie-parser';
import { attachUser, checkOrigin } from './middleware/auth';
import { resolveOffice } from './middleware/office';
import { officesRoutes, productsRoutes } from './routes/offices.routes';
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
import { staffRoutes } from './routes/staff.routes';
import { checkingRoutes, dispatchesRoutes, packingRoutes } from './routes/checking.routes';
import { discrepanciesRoutes } from './routes/discrepancies.routes';
import { reportsRoutes, traceRoutes } from './routes/reports.routes';
import { dashboardRoutes } from './routes/dashboard.routes';

/**
 * Runtime-neutral assembly of the API.
 *
 * The identical route/service code serves two hosts:
 *  - the Node/Express server (server/src/app.ts) — used for development, the whole
 *    automated test suite, and an optional PC deployment;
 *  - the in-app server that runs inside the Android WebView worker
 *    (client/src/local/server.worker.ts), where `express` and the node builtins
 *    resolve to small shims.
 *
 * Anything that can only exist on one of them (self-update via a supervisor, disk
 * backups, demo-mode data directories) is injected as `systemOps` rather than
 * imported here, so the Android bundle never pulls Node-only code.
 */

export type CoreAppOptions = {
  /** Host-specific /api/system endpoints (updates, backups, restore, demo mode). */
  systemOps?: Router;
};

export function mountCoreMiddleware(app: express.Express): void {
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  app.use(checkOrigin);
  app.use(attachUser);
  // ADR-028: every signed-in request operates in exactly one office
  app.use(resolveOffice);
}

export function mountApiRoutes(app: express.Express, options: CoreAppOptions = {}): void {
  app.use('/api/system', systemRoutes(options.systemOps));
  app.use('/api/offices', officesRoutes());
  app.use('/api/products', productsRoutes());
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
  app.use('/api/staff', staffRoutes());
  app.use('/api/checking', checkingRoutes());
  app.use('/api/packing', packingRoutes());
  app.use('/api/dispatches', dispatchesRoutes());
  app.use('/api/discrepancies', discrepanciesRoutes());
  app.use('/api/reports', reportsRoutes());
  app.use('/api/trace', traceRoutes());
  app.use('/api/dashboard', dashboardRoutes());

  // Unknown API routes are a JSON 404, not the SPA fallback.
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
}

/** Express 5 forwards async throws here automatically. */
export function mountErrorHandler(app: express.Express): void {
  app.use(
    (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      // SQLite constraint violations (unknown foreign key, CHECK breach) are client
      // errors — a well-formed request can never trigger them.
      const code = (err as { code?: string }).code;
      if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) {
        res.status(400).json({
          error: 'A referenced record does not exist or the values break a data rule.',
        });
        return;
      }
      // body-parser errors (malformed JSON, oversized payloads) carry their own 4xx status
      const status = (err as { status?: number }).status;
      if (typeof status === 'number' && status >= 400 && status < 500) {
        res.status(status).json({ error: 'Invalid request body.' });
        return;
      }
      console.error('[error]', err);
      res.status(500).json({ error: 'Internal server error' });
    },
  );
}
