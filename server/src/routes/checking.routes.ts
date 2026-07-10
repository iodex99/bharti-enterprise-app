import { Router } from 'express';
import {
  checkIssueSchema,
  checkResultSchema,
  dispatchSchema,
  packIssueSchema,
  packResultSchema,
  voidSchema,
} from '@shared';
import { getDb } from '../db/connection';
import { requireAuth, requireRole } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { idempotencyGuard, recordIdempotency } from '../middleware/idempotency';
import {
  createCheckIssue,
  listCheckIssues,
  recordCheckResult,
  voidCheckIssue,
} from '../services/checking.service';
import {
  createDispatch,
  createPackIssue,
  listDispatches,
  listPackIssues,
  recordPackResult,
  voidDispatch,
  voidPackIssue,
} from '../services/packing.service';

export function checkingRoutes(): Router {
  const router = Router();

  router.get('/', requireAuth, (_req, res) => {
    res.json({ items: listCheckIssues(getDb()) });
  });

  router.post(
    '/',
    requireRole('admin', 'operator'),
    idempotencyGuard('check_issue'),
    validateBody(checkIssueSchema),
    (req, res) => {
      const result = createCheckIssue(getDb(), req.body, req.user!.id, req.ip ?? null, (id) =>
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
    '/:id/results',
    requireRole('admin', 'operator'),
    validateBody(checkResultSchema),
    (req, res) => {
      const result = recordCheckResult(getDb(), Number(req.params.id), req.body, req.user!.id, req.ip ?? null);
      if (!result.ok) {
        res.status(result.code).json({ error: result.error });
        return;
      }
      res.status(201).json({ id: result.id, status: result.status });
    },
  );

  router.post('/:id/void', requireRole('admin'), validateBody(voidSchema), (req, res) => {
    const result = voidCheckIssue(
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

export function packingRoutes(): Router {
  const router = Router();

  router.get('/', requireAuth, (_req, res) => {
    res.json({ items: listPackIssues(getDb()) });
  });

  router.post(
    '/',
    requireRole('admin', 'operator'),
    idempotencyGuard('pack_issue'),
    validateBody(packIssueSchema),
    (req, res) => {
      const result = createPackIssue(getDb(), req.body, req.user!.id, req.ip ?? null, (id) =>
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
    '/:id/results',
    requireRole('admin', 'operator'),
    validateBody(packResultSchema),
    (req, res) => {
      const result = recordPackResult(getDb(), Number(req.params.id), req.body, req.user!.id, req.ip ?? null);
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
      Number(req.params.id),
      (req.body as { reason: string }).reason,
      req.user!.id,
      req.ip ?? null,
    );
    res.status(result.ok ? 200 : result.code).json(result.ok ? { ok: true } : { error: result.error });
  });

  return router;
}

export function dispatchesRoutes(): Router {
  const router = Router();

  router.get('/', requireAuth, (_req, res) => {
    res.json({ items: listDispatches(getDb()) });
  });

  router.post(
    '/',
    requireRole('admin'),
    idempotencyGuard('fg_dispatch'),
    validateBody(dispatchSchema),
    (req, res) => {
      const result = createDispatch(getDb(), req.body, req.user!.id, req.ip ?? null, (id) =>
        recordIdempotency(getDb(), res, id),
      );
      if (!result.ok) {
        res.status(result.code).json({ error: result.error });
        return;
      }
      res.status(201).json({ id: result.id, docNo: result.docNo });
    },
  );

  router.post('/:id/void', requireRole('admin'), validateBody(voidSchema), (req, res) => {
    const result = voidDispatch(
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
