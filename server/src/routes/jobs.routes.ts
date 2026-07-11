import { Router } from 'express';
import { jobCardSchema, jobCloseSchema, jobReceiptSchema, paymentSchema, voidSchema } from '@shared';
import { getDb } from '../db/connection';
import { requireAuth, requireRole } from '../middleware/auth';
import { idParamGuard } from '../middleware/params';
import { validateBody } from '../middleware/validate';
import { idempotencyGuard, recordIdempotency } from '../middleware/idempotency';
import {
  closeJobWithDiscrepancy,
  createJobCard,
  createReceipt,
  jobReceiptsFor,
  listJobCards,
  voidJobCard,
} from '../services/jobs.service';
import {
  contractorAnalytics,
  createPayment,
  listPayments,
  voidPayment,
} from '../services/contractors.service';

export function jobsRoutes(): Router {
  const router = Router();
  router.param('id', idParamGuard);

  router.get('/', requireAuth, (req, res) => {
    const num = (v: unknown) => (v && !Number.isNaN(Number(v)) ? Number(v) : undefined);
    res.json({
      items: listJobCards(getDb(), {
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
        contractorId: num(req.query.contractorId),
        includeVoided: req.query.includeVoided === '1',
      }),
    });
  });

  router.get('/:id/receipts', requireAuth, (req, res) => {
    res.json({ items: jobReceiptsFor(getDb(), Number(req.params.id)) });
  });

  router.post(
    '/',
    requireRole('admin', 'operator'),
    idempotencyGuard('job_card'),
    validateBody(jobCardSchema),
    (req, res) => {
      const result = createJobCard(getDb(), req.body, req.user!.id, req.ip ?? null, (id) =>
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
    '/:id/receipts',
    requireRole('admin', 'operator'),
    idempotencyGuard('job_receipt'),
    validateBody(jobReceiptSchema),
    (req, res) => {
      const result = createReceipt(
        getDb(),
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

  router.get('/analytics', requireAuth, (_req, res) => {
    res.json({ items: contractorAnalytics(getDb()) });
  });

  router.get('/payments', requireAuth, (req, res) => {
    const num = (v: unknown) => (v && !Number.isNaN(Number(v)) ? Number(v) : undefined);
    res.json({ items: listPayments(getDb(), num(req.query.contractorId)) });
  });

  router.post(
    '/payments',
    requireRole('admin', 'operator'),
    idempotencyGuard('contractor_payment'),
    validateBody(paymentSchema),
    (req, res) => {
      const result = createPayment(getDb(), req.body, req.user!.id, req.ip ?? null, (id) =>
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
      Number(req.params.id),
      (req.body as { reason: string }).reason,
      req.user!.id,
      req.ip ?? null,
    );
    res.status(result.ok ? 200 : result.code).json(result.ok ? { ok: true } : { error: result.error });
  });

  return router;
}
