import { Router } from 'express';
import { cuttingActualsSchema, cuttingPlanSchema, voidSchema } from '@shared';
import { getDb } from '../db/connection';
import { requireAuth, requireRole } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { idempotencyGuard, recordIdempotency } from '../middleware/idempotency';
import {
  createCuttingPlan,
  listCuttingBatches,
  recordActuals,
  voidCuttingBatch,
} from '../services/cutting.service';

export function cuttingRoutes(): Router {
  const router = Router();

  router.get('/', requireAuth, (req, res) => {
    res.json({
      items: listCuttingBatches(getDb(), {
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
        includeVoided: req.query.includeVoided === '1',
      }),
    });
  });

  router.post(
    '/',
    requireRole('admin', 'operator'),
    idempotencyGuard('cutting_batch'),
    validateBody(cuttingPlanSchema),
    (req, res) => {
      const result = createCuttingPlan(getDb(), req.body, req.user!.id, req.ip ?? null, (id) =>
        recordIdempotency(getDb(), res, id),
      );
      if (!result.ok) {
        res.status(result.code).json({ error: result.error });
        return;
      }
      res.status(201).json({ id: result.id, docNo: result.docNo });
    },
  );

  router.post(
    '/:id/actuals',
    requireRole('admin', 'operator'),
    validateBody(cuttingActualsSchema),
    (req, res) => {
      const result = recordActuals(getDb(), Number(req.params.id), req.body, req.user!.id, req.ip ?? null);
      res.status(result.ok ? 200 : result.code).json(result.ok ? { ok: true } : { error: result.error });
    },
  );

  router.post('/:id/void', requireRole('admin'), validateBody(voidSchema), (req, res) => {
    const result = voidCuttingBatch(
      getDb(),
      Number(req.params.id),
      (req.body as { reason: string }).reason,
      req.user!.id,
      req.ip ?? null,
    );
    res.status(result.ok ? 200 : result.code).json(result.ok ? { ok: true } : { error: result.error });
  });

  return router;
}
