import { Router } from 'express';
import {
  checkIssueEditSchema,
  checkIssueSchema,
  checkResultSchema,
  dispatchSchema,
  packIssueEditSchema,
  packIssueSchema,
  packResultSchema,
  voidSchema,
  type CheckResultInput,
} from '@shared';
import { z } from 'zod';
import { getDb } from '../db/connection';
import { requireAuth, requireRole } from '../middleware/auth';
import { officeOf } from '../middleware/office';
import { idParamGuard } from '../middleware/params';
import { validateBody } from '../middleware/validate';
import { idempotencyGuard, recordIdempotency } from '../middleware/idempotency';
import {
  createCheckIssue,
  editCheckIssue,
  listCheckIssues,
  listPendingChecking,
  recordCheckResult,
  voidCheckIssue,
} from '../services/checking.service';
import {
  createDispatch,
  createPackIssue,
  editDispatch,
  editPackIssue,
  listDispatches,
  listPackIssues,
  listPacked,
  recordPackResult,
  voidDispatch,
  voidPackIssue,
} from '../services/packing.service';

class PackNowError extends Error {}

/**
 * Checking v2 (ADR-034/035). Packing has NO page of its own: it is allotted from the
 * checking rows here — POST /:id/pack allots THIS check issue's passed pieces to a
 * packer (default: the checker) or keeps them aside as a labeled bundle.
 */
export function checkingRoutes(): Router {
  const router = Router();
  router.param('id', idParamGuard);

  router.get('/', requireAuth, (req, res) => {
    res.json({ items: listCheckIssues(getDb(), officeOf(req).id) });
  });

  /** Received-but-unchecked batches, with contractor + receipt photo (the pool). */
  router.get('/pending', requireAuth, (req, res) => {
    res.json({ items: listPendingChecking(getDb(), officeOf(req).id) });
  });

  router.post(
    '/',
    requireRole('admin', 'operator'),
    idempotencyGuard('check_issue'),
    validateBody(checkIssueSchema),
    (req, res) => {
      const result = createCheckIssue(
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

  router.post(
    '/:id/results',
    requireRole('admin', 'operator'),
    validateBody(checkResultSchema),
    (req, res) => {
      const db = getDb();
      const office = officeOf(req);
      const checkIssueId = Number(req.params.id);
      const body = req.body as CheckResultInput;
      // "pack now": the result and the hand-over to packing happen together or not at all
      let response: { status: number; body: Record<string, unknown> } = { status: 500, body: {} };
      try {
        db.transaction(() => {
          const result = recordCheckResult(
            db,
            office,
            checkIssueId,
            body,
            req.user!.id,
            req.ip ?? null,
          );
          if (!result.ok) {
            response = { status: result.code, body: { error: result.error } };
            return;
          }
          let pack: { id: number; docNo: string } | null = null;
          if (body.packNow && body.qtyPassed > 0) {
            const issue = db
              .prepare('SELECT staff_id FROM check_issues WHERE id = ?')
              .get(checkIssueId) as {
              staff_id: number;
            };
            const waiting = (
              db
                .prepare(
                  `SELECT COALESCE(SUM(qty),0) AS bal FROM stock_ledger
                   WHERE stage='PACKING' AND staff_id IS NULL AND lot_type='check_issue' AND lot_id = ?`,
                )
                .get(checkIssueId) as { bal: number }
            ).bal;
            const packed = createPackIssue(
              db,
              office,
              {
                issueDate: body.resultDate,
                staffId: issue.staff_id,
                lotType: 'check_issue',
                lotId: checkIssueId,
                qtyPcs: waiting,
                kind: 'pack',
                label: '',
                notes: '',
              },
              req.user!.id,
              req.ip ?? null,
            );
            if (!packed.ok) throw new PackNowError(packed.error);
            pack = { id: packed.id, docNo: packed.docNo };
          }
          response = { status: 201, body: { id: result.id, status: result.status, pack } };
        })();
      } catch (err) {
        if (err instanceof PackNowError) {
          res.status(409).json({ error: `Nothing was saved: ${err.message}` });
          return;
        }
        throw err;
      }
      res.status(response.status).json(response.body);
    },
  );

  /** Edit a check issue: checker/quantity before results, date/rate/notes always. */
  router.put(
    '/:id',
    requireRole('admin', 'operator'),
    validateBody(checkIssueEditSchema),
    (req, res) => {
      const result = editCheckIssue(
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

  /**
   * Allot packing straight from a checking row: this check issue's passed pieces go to
   * the chosen packer (kind 'pack') or are kept aside as a labeled bundle (kind
   * 'bundle'). The lot is implied — it IS this check issue.
   */
  const packHereSchema = packIssueSchema.omit({ lotType: true, lotId: true });
  router.post(
    '/:id/pack',
    requireRole('admin', 'operator'),
    idempotencyGuard('pack_issue'),
    validateBody(packHereSchema),
    (req, res) => {
      const body = req.body as z.infer<typeof packHereSchema>;
      const result = createPackIssue(
        getDb(),
        officeOf(req),
        { ...body, lotType: 'check_issue', lotId: Number(req.params.id) },
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

  router.post('/:id/void', requireRole('admin'), validateBody(voidSchema), (req, res) => {
    const result = voidCheckIssue(
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

/**
 * Packing endpoints (no page of their own — driven from the checking screen):
 * list pack work + bundles, record results, allot from opening/bundle lots, void.
 */
export function packingRoutes(): Router {
  const router = Router();
  router.param('id', idParamGuard);

  router.get('/', requireAuth, (req, res) => {
    const kind =
      req.query.kind === 'bundle' ? 'bundle' : req.query.kind === 'pack' ? 'pack' : undefined;
    res.json({ items: listPackIssues(getDb(), officeOf(req).id, { kind }) });
  });

  /** Packed goods register: every packing session that produced finished goods. */
  router.get('/packed', requireAuth, (req, res) => {
    res.json({ items: listPacked(getDb(), officeOf(req).id) });
  });

  /** Edit a pack issue / bundle: packer/quantity before results, the rest always. */
  router.put(
    '/:id',
    requireRole('admin', 'operator'),
    validateBody(packIssueEditSchema),
    (req, res) => {
      const result = editPackIssue(
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

  /** Directed allotment from any packing-pool lot (opening lots, bundles). */
  router.post(
    '/',
    requireRole('admin', 'operator'),
    idempotencyGuard('pack_issue'),
    validateBody(packIssueSchema),
    (req, res) => {
      const result = createPackIssue(
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

  router.post(
    '/:id/results',
    requireRole('admin', 'operator'),
    validateBody(packResultSchema),
    (req, res) => {
      const result = recordPackResult(
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
      res.status(201).json({ id: result.id, status: result.status });
    },
  );

  router.post('/:id/void', requireRole('admin'), validateBody(voidSchema), (req, res) => {
    const result = voidPackIssue(
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

export function dispatchesRoutes(): Router {
  const router = Router();
  router.param('id', idParamGuard);

  router.get('/', requireAuth, (req, res) => {
    res.json({ items: listDispatches(getDb(), officeOf(req).id) });
  });

  router.post(
    '/',
    requireRole('admin'),
    idempotencyGuard('fg_dispatch'),
    validateBody(dispatchSchema),
    (req, res) => {
      const result = createDispatch(
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

  /** Edit a dispatch (admin): the old take goes back, the corrected one takes FIFO. */
  router.put('/:id', requireRole('admin'), validateBody(dispatchSchema), (req, res) => {
    const result = editDispatch(
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

  router.post('/:id/void', requireRole('admin'), validateBody(voidSchema), (req, res) => {
    const result = voidDispatch(
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
