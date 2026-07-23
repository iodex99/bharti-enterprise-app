import { Router } from 'express';
import { purchaseEditSchema, purchaseSchema, voidSchema } from '@shared';
import { getDb } from '../db/connection';
import { requireAuth, requireRole } from '../middleware/auth';
import { idParamGuard } from '../middleware/params';
import { validateBody } from '../middleware/validate';
import { idempotencyGuard, recordIdempotency } from '../middleware/idempotency';
import {
  createPurchase,
  editPurchase,
  listPurchases,
  voidPurchase,
} from '../services/purchases.service';

export function purchasesRoutes(): Router {
  const router = Router();
  router.param('id', idParamGuard);

  router.get('/', requireAuth, (req, res) => {
    const num = (v: unknown) => (v && !Number.isNaN(Number(v)) ? Number(v) : undefined);
    res.json({
      items: listPurchases(getDb(), {
        vendorId: num(req.query.vendorId),
        colorId: num(req.query.colorId),
        from: typeof req.query.from === 'string' ? req.query.from : undefined,
        to: typeof req.query.to === 'string' ? req.query.to : undefined,
        includeVoided: req.query.includeVoided === '1',
      }),
    });
  });

  router.post(
    '/',
    requireRole('admin', 'operator'),
    idempotencyGuard('purchase'),
    validateBody(purchaseSchema),
    (req, res) => {
      const result = createPurchase(getDb(), req.body, req.user!.id, req.ip ?? null, (id) =>
        recordIdempotency(getDb(), res, id),
      );
      if (!result.ok) {
        res.status(result.code).json({ error: result.error });
        return;
      }
      res.status(201).json({ id: result.id, docNo: result.docNo });
    },
  );

  router.put('/:id', requireRole('admin', 'operator'), validateBody(purchaseEditSchema), (req, res) => {
    const result = editPurchase(getDb(), Number(req.params.id), req.body, req.user!.id, req.ip ?? null);
    res.status(result.ok ? 200 : result.code).json(result.ok ? { ok: true } : { error: result.error });
  });

  router.post('/:id/void', requireRole('admin'), validateBody(voidSchema), (req, res) => {
    const result = voidPurchase(
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
