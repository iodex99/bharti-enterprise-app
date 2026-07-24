import { Router } from 'express';
import {
  jobCloseSchema,
  jobEditSchema,
  jobIssueSchema,
  jobReceiptSchema,
  paymentSchema,
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
  jobReceiptsFor,
  listJobCards,
  voidJobCard,
} from '../services/jobs.service';
import {
  contractorAnalytics,
  createPayment,
  listPayments,
  listPendingDues,
  voidPayment,
} from '../services/contractors.service';

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

  /** The combined issue: lines across codes/colors → ONE CARD PER code+color (ADR-033). */
  router.post(
    '/',
    requireRole('admin', 'operator'),
    idempotencyGuard('job_card'),
    validateBody(jobIssueSchema),
    (req, res) => {
      const result = createJobIssue(getDb(), officeOf(req), req.body, req.user!.id, req.ip ?? null, (id) =>
        recordIdempotency(getDb(), res, id),
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
    const result = editJobCard(getDb(), officeOf(req), Number(req.params.id), req.body, req.user!.id, req.ip ?? null);
    res.status(result.ok ? 200 : result.code).json(result.ok ? { ok: true } : { error: result.error });
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
    res.status(result.ok ? 200 : result.code).json(result.ok ? { ok: true } : { error: result.error });
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
    res.status(result.ok ? 200 : result.code).json(result.ok ? { ok: true } : { error: result.error });
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
      const result = createPayment(getDb(), officeOf(req), req.body, req.user!.id, req.ip ?? null, (id) =>
        recordIdempotency(getDb(), res, id),
      );
      if (!result.ok) {
        res.status(result.code).json({ error: result.error });
        return;
      }
      res.status(201).json({ id: result.id, docNo: result.docNo });
    },
  );

  router.post('/payments/:id/void', requireRole('admin'), validateBody(voidSchema), (req, res) => {
    const result = voidPayment(
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
