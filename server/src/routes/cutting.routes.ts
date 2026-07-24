import { Router } from 'express';
import { cuttingPlanSchema, voidSchema } from '@shared';
import { getDb } from '../db/connection';
import { requireAuth, requireRole } from '../middleware/auth';
import { officeOf } from '../middleware/office';
import { idParamGuard } from '../middleware/params';
import { validateBody } from '../middleware/validate';
import { idempotencyGuard, recordIdempotency } from '../middleware/idempotency';
import {
  createCuttingPlan,
  deleteCuttingBatch,
  editCuttingPlan,
  listCuttingBatches,
  voidCuttingBatch,
} from '../services/cutting.service';

/**
 * Cutting v2 (ADR-030/031): the plan IS the cutting — creating it consumes cloth and
 * creates the CUT pieces at once. Edit/delete are available while nothing has moved
 * downstream. There is no actuals endpoint any more.
 */
export function cuttingRoutes(): Router {
  const router = Router();
  router.param('id', idParamGuard);

  router.get('/', requireAuth, (req, res) => {
    res.json({
      items: listCuttingBatches(getDb(), officeOf(req).id, {
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
      const result = createCuttingPlan(getDb(), officeOf(req), req.body, req.user!.id, req.ip ?? null, (id) =>
        recordIdempotency(getDb(), res, id),
      );
      if (!result.ok) {
        res.status(result.code).json({ error: result.error });
        return;
      }
      res.status(201).json({ id: result.id, docNo: result.docNo });
    },
  );

  /** Edit — allowed while none of the batch's pieces moved downstream. Same body as create. */
  router.put('/:id', requireRole('admin', 'operator'), validateBody(cuttingPlanSchema), (req, res) => {
    const result = editCuttingPlan(getDb(), officeOf(req), Number(req.params.id), req.body, req.user!.id, req.ip ?? null);
    res.status(result.ok ? 200 : result.code).json(result.ok ? { ok: true } : { error: result.error });
  });

  /** Delete (soft: void with a standard reason; cloth restored). Same downstream guard. */
  router.delete('/:id', requireRole('admin', 'operator'), (req, res) => {
    const result = deleteCuttingBatch(getDb(), officeOf(req), Number(req.params.id), req.user!.id, req.ip ?? null);
    res.status(result.ok ? 200 : result.code).json(result.ok ? { ok: true } : { error: result.error });
  });

  router.post('/:id/void', requireRole('admin'), validateBody(voidSchema), (req, res) => {
    const result = voidCuttingBatch(
      getDb(),
      officeOf(req),
      Number(req.params.id),
      (req.body as { reason: string }).reason,
      req.user!.id,
      req.ip ?? null,
    );
    res.status(result.ok ? 200 : result.code).json(result.ok ? { ok: true } : { error: result.error });
  });

  return router;
}
