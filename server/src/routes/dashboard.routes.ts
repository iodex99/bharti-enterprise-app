import { Router } from 'express';
import { getDb } from '../db/connection';
import { requireAuth } from '../middleware/auth';
import { alerts, dashboardData } from '../services/dashboard.service';

export function dashboardRoutes(): Router {
  const router = Router();
  router.use(requireAuth);

  router.get('/', (_req, res) => {
    res.json(dashboardData(getDb()));
  });

  router.get('/alerts', (_req, res) => {
    res.json({ items: alerts(getDb()) });
  });

  return router;
}
