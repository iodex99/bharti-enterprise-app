import { Router } from 'express';
import { paymentEditSchema, staffPaymentSchema, voidSchema } from '@shared';
import { getDb } from '../db/connection';
import { requireAuth, requireRole } from '../middleware/auth';
import { officeOf } from '../middleware/office';
import { idParamGuard } from '../middleware/params';
import { validateBody } from '../middleware/validate';
import { idempotencyGuard, recordIdempotency } from '../middleware/idempotency';
import {
  createStaffPayment,
  editStaffPayment,
  listStaffDues,
  listStaffPayments,
  staffAnalytics,
  voidStaffPayment,
} from '../services/staffpay.service';
import { staffStatement } from '../services/statements.service';
import { periodOf, statementFileName } from './statement.helpers';
import { renderStatementPdf } from '../utils/statementPdf';

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

  /** Correct a payment (admin — it is money out, like a void). */
  router.put('/payments/:id', requireRole('admin'), validateBody(paymentEditSchema), (req, res) => {
    const result = editStaffPayment(
      getDb(),
      officeOf(req),
      Number(req.params.id),
      req.body,
      req.user!.id,
      req.ip ?? null,
    );
    res
      .status(result.ok ? 200 : result.code)
      .json(result.ok ? { ok: true } : { error: result.error });
  });

  /**
   * The person's ledger (ADR-047): work, deductions, payments, running balance and the
   * breakdown of how the amount owed was worked out. ?from=&to= limit the period.
   */
  router.get('/:id/statement', requireAuth, (req, res) => {
    const st = staffStatement(
      getDb(),
      officeOf(req).id,
      Number(req.params.id),
      periodOf(req.query),
    );
    if (!st) {
      res.status(404).json({ error: 'Staff member not found.' });
      return;
    }
    res.json(st);
  });

  /** The same statement as a PDF to send to them (WhatsApp, print). */
  router.get('/:id/statement/pdf', requireAuth, async (req, res) => {
    const st = staffStatement(
      getDb(),
      officeOf(req).id,
      Number(req.params.id),
      periodOf(req.query),
    );
    if (!st) {
      res.status(404).json({ error: 'Staff member not found.' });
      return;
    }
    const pdf = await renderStatementPdf(st, new Date().toISOString());
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${statementFileName(st)}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.end(Buffer.from(pdf));
  });

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
