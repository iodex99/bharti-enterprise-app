import { Router } from 'express';
import { staffPaymentSchema, voidSchema } from '@shared';
import { getDb } from '../db/connection';
import { requireAuth, requireRole } from '../middleware/auth';
import { officeOf } from '../middleware/office';
import { idParamGuard } from '../middleware/params';
import { validateBody } from '../middleware/validate';
import { idempotencyGuard, recordIdempotency } from '../middleware/idempotency';
import {
  createStaffPayment,
  listStaffDues,
  listStaffPayments,
  staffAnalytics,
  voidStaffPayment,
} from '../services/staffpay.service';

/**
 * Checker/packer pay: earnings per dozen (rate snapshotted on each check/pack issue),
 * dues, and dated partial payments — the staff mirror of the contractor money routes.
 */
export function staffRoutes(): Router {
  const router = Router();
  router.param('id', idParamGuard);

  router.get('/analytics', requireAuth, (req, res) => {
    res.json({ items: staffAnalytics(getDb(), officeOf(req).id) });
  });

  /** Staff pending dues: work done × rate − payments, largest first. */
  router.get('/dues', requireAuth, (req, res) => {
    res.json(listStaffDues(getDb(), officeOf(req).id));
  });

  router.get('/payments', requireAuth, (req, res) => {
    const num = (v: unknown) => (v && !Number.isNaN(Number(v)) ? Number(v) : undefined);
    res.json({ items: listStaffPayments(getDb(), officeOf(req).id, num(req.query.staffId)) });
  });

  router.post(
    '/payments',
    requireRole('admin', 'operator'),
    idempotencyGuard('staff_payment'),
    validateBody(staffPaymentSchema),
    (req, res) => {
      const result = createStaffPayment(
        getDb(),
        officeOf(req),
        req.body,
        req.user!.id,
        req.ip ?? null,
        (id) => recordIdempotency(getDb(), res, id),
      );
      if (!result.ok) {
        res.status(result.code).json({ error: result.error });
        return;
      }
      res.status(201).json({ id: result.id, docNo: result.docNo });
    },
  );

  router.post('/payments/:id/void', requireRole('admin'), validateBody(voidSchema), (req, res) => {
    const result = voidStaffPayment(
      getDb(),
      officeOf(req),
      Number(req.params.id),
      (req.body as { reason: string }).reason,
      req.user!.id,
      req.ip ?? null,
    );
    res
      .status(result.ok ? 200 : result.code)
      .json(result.ok ? { ok: true } : { error: result.error });
  });

  return router;
}
