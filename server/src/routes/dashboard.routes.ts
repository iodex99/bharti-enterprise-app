import { Router } from 'express';
import { getDb } from '../db/connection';
import { requireAuth } from '../middleware/auth';
import { officeOf } from '../middleware/office';
import { alerts, dashboardData } from '../services/dashboard.service';

export function dashboardRoutes(): Router {
  const router = Router();
  router.use(requireAuth);

  router.get('/', (req, res) => {
    res.json(dashboardData(getDb(), officeOf(req).id));
  });

  router.get('/alerts', (req, res) => {
    res.json({ items: alerts(getDb(), officeOf(req).id) });
  });

  return router;
}
