import { Router } from 'express';
import { config } from '../config';

export function systemRoutes(): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      version: config.version,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  router.get('/version', (_req, res) => {
    res.json({ version: config.version });
  });

  return router;
}
