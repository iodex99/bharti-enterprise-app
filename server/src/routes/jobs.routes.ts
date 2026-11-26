import { Router } from 'express';
import {
  jobCloseSchema,
  jobEditSchema,
  jobIssueSchema,
  jobReceiptSchema,
  paymentEditSchema,
  paymentSchema,
  receiptEditSchema,
  voidSchema,
} from '@shared';
import { getDb } from '../db/connection';
import { requireAuth, requireRole } from '../middleware/auth';
import { officeOf } from '../middleware/office';
import { idParamGuard } from '../middleware/params';
import { validateBody } from '../middleware/validate';
import { idempotencyGuard, recordIdempotency } from '../middleware/idempotency';
import {
  closeJobWithDiscrepancy,
  createJobIssue,
  createReceipt,
  editJobCard,
  editReceipt,
  jobReceiptsFor,
  listJobCards,
  voidJobCard,
} from '../services/jobs.service';
import {
  contractorAnalytics,
  createPayment,
  editPayment,
  listPayments,
  listPendingDues,
  voidPayment,
} from '../services/contractors.service';
import { contractorStatement } from '../services/statements.service';
import { periodOf, statementFileName } from './statement.helpers';
import { renderStatementPdf } from '../utils/statementPdf';

export function jobsRoutes(): Router {
  const router = Router();
  router.param('id', idParamGuard);

  router.get('/', requireAuth, (req, res) => {
    const num = (v: unknown) => (v && !Number.isNaN(Number(v)) ? Number(v) : undefined);
    res.json({
      items: listJobCards(getDb(), officeOf(req).id, {
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
        contractorId: num(req.query.contractorId),
        includeVoided: req.query.includeVoided === '1',
      }),
    });
  });

  router.get('/:id/receipts', requireAuth, (req, res) => {
    res.json({ items: jobReceiptsFor(getDb(), officeOf(req).id, Number(req.params.id)) });
  });

  /** Correct a receipt's date, photo or notes (its pieces are fixed once recorded). */
  router.put(
    '/receipts/:id',
    requireRole('admin', 'operator'),
    validateBody(receiptEditSchema),
    (req, res) => {
      const result = editReceipt(
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
    },
  );

  /** The combined issue: lines across codes/colors → ONE CARD PER code+color (ADR-033). */
  router.post(
    '/',
    requireRole('admin', 'operator'),
    idempotencyGuard('job_card'),
    validateBody(jobIssueSchema),
    (req, res) => {
      const result = createJobIssue(
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
      res.status(201).json({ cards: result.cards });
    },
  );

  /** Edit an unstarted card (no receipts yet). */
  router.put('/:id', requireRole('admin', 'operator'), validateBody(jobEditSchema), (req, res) => {
    const result = editJobCard(
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

  /** Delete an unstarted card (soft: void with a standard reason; CUT stock restored). */
  router.delete('/:id', requireRole('admin', 'operator'), (req, res) => {
    const result = voidJobCard(
      getDb(),
      officeOf(req),
      Number(req.params.id),
      'job card deleted before any receipt',
      req.user!.id,
      req.ip ?? null,
    );
    res
      .status(result.ok ? 200 : result.code)
      .json(result.ok ? { ok: true } : { error: result.error });
  });

  router.post(
    '/:id/receipts',
    requireRole('admin', 'operator'),
    idempotencyGuard('job_receipt'),
    validateBody(jobReceiptSchema),
    (req, res) => {
      const result = createReceipt(
        getDb(),
        officeOf(req),
        Number(req.params.id),
        req.body,
        req.user!.id,
        req.ip ?? null,
        (id) => recordIdempotency(getDb(), res, id),
      );
      if (!result.ok) {
        res.status(result.code).json({ error: result.error });
        return;
      }
      res.status(201).json({ id: result.id, docNo: result.docNo, status: result.status });
    },
  );

  router.post('/:id/close', requireRole('admin'), validateBody(jobCloseSchema), (req, res) => {
    const result = closeJobWithDiscrepancy(
      getDb(),
      officeOf(req),
      Number(req.params.id),
      req.body,
      req.user!.id,
      req.ip ?? null,
    );
    if (!result.ok) {
      res.status(result.code).json({ error: result.error });
      return;
    }
    res.json({ ok: true, shortagePcs: result.shortagePcs });
  });

  router.post('/:id/void', requireRole('admin'), validateBody(voidSchema), (req, res) => {
    const result = voidJobCard(
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

export function contractorsRoutes(): Router {
  const router = Router();
  router.param('id', idParamGuard);

  router.get('/analytics', requireAuth, (req, res) => {
    res.json({ items: contractorAnalytics(getDb(), officeOf(req).id) });
  });

  /** Pending dues at a glance (ADR-036): who is owed what, largest first. */
  router.get('/dues', requireAuth, (req, res) => {
    res.json(listPendingDues(getDb(), officeOf(req).id));
  });

  router.get('/payments', requireAuth, (req, res) => {
    const num = (v: unknown) => (v && !Number.isNaN(Number(v)) ? Number(v) : undefined);
    res.json({ items: listPayments(getDb(), officeOf(req).id, num(req.query.contractorId)) });
  });

  router.post(
    '/payments',
    requireRole('admin', 'operator'),
    idempotencyGuard('contractor_payment'),
    validateBody(paymentSchema),
    (req, res) => {
      const result = createPayment(
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
    const result = editPayment(
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
    const st = contractorStatement(
      getDb(),
      officeOf(req).id,
      Number(req.params.id),
      periodOf(req.query),
    );
    if (!st) {
      res.status(404).json({ error: 'Contractor not found.' });
      return;
    }
    res.json(st);
  });

  /** The same statement as a PDF to send to them (WhatsApp, print). */
  router.get('/:id/statement/pdf', requireAuth, async (req, res) => {
    const st = contractorStatement(
      getDb(),
      officeOf(req).id,
      Number(req.params.id),
      periodOf(req.query),
    );
    if (!st) {
      res.status(404).json({ error: 'Contractor not found.' });
      return;
    }
    const pdf = await renderStatementPdf(st, new Date().toISOString());
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${statementFileName(st)}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.end(Buffer.from(pdf));
  });

  router.post('/payments/:id/void', requireRole('admin'), validateBody(voidSchema), (req, res) => {
    const result = voidPayment(
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
