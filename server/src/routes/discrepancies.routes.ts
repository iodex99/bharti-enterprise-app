import { Router } from 'express';
import { resolveDiscrepancySchema } from '@shared';
import { getDb } from '../db/connection';
import { requireAuth, requireRole } from '../middleware/auth';
import { officeOf } from '../middleware/office';
import { idParamGuard } from '../middleware/params';
import { validateBody } from '../middleware/validate';
import { listDiscrepancies, resolveDiscrepancy } from '../services/discrepancies.service';

export function discrepanciesRoutes(): Router {
  const router = Router();
  router.param('id', idParamGuard);

  router.get('/', requireAuth, (req, res) => {
    res.json({ items: listDiscrepancies(getDb(), officeOf(req).id) });
  });

  // Resolving is a supervisory judgement (like close-with-discrepancy) → admin-only.
  router.post('/:id/resolve', requireRole('admin'), validateBody(resolveDiscrepancySchema), (req, res) => {
    const result = resolveDiscrepancy(
      getDb(),
      Number(req.params.id),
      (req.body as { note: string }).note,
      req.user!.id,
      req.ip ?? null,
    );
    res.status(result.ok ? 200 : result.code).json(result.ok ? { ok: true } : { error: result.error });
  });

  return router;
}
