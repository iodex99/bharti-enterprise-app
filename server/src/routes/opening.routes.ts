import { Router } from 'express';
import { openingBalanceSchema, voidSchema } from '@shared';
import { getDb } from '../db/connection';
import { requireRole } from '../middleware/auth';
import { idParamGuard } from '../middleware/params';
import { validateBody } from '../middleware/validate';
import { idempotencyGuard, recordIdempotency } from '../middleware/idempotency';
import {
  createOpeningBalance,
  listOpeningBalances,
  voidOpeningBalance,
} from '../services/opening.service';

export function openingRoutes(): Router {
  const router = Router();
  router.param('id', idParamGuard);
  router.use(requireRole('admin'));

  router.get('/', (_req, res) => {
    res.json({ items: listOpeningBalances(getDb()) });
  });

  router.post('/', idempotencyGuard('opening_balance'), validateBody(openingBalanceSchema), (req, res) => {
    const result = createOpeningBalance(getDb(), req.body, req.user!.id, req.ip ?? null);
    if (!result.ok) {
      res.status(result.code).json({ error: result.error });
      return;
    }
    recordIdempotency(getDb(), res, result.id);
    res.status(201).json({ id: result.id, docNo: result.docNo });
  });

  router.post('/:id/void', validateBody(voidSchema), (req, res) => {
    const result = voidOpeningBalance(
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
