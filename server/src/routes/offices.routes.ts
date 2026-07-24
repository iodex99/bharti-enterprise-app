import { Router } from 'express';
import { officeSchema } from '@shared';
import { z } from 'zod';
import { getDb } from '../db/connection';
import { requireAuth, requireRole } from '../middleware/auth';
import { idParamGuard } from '../middleware/params';
import { validateBody } from '../middleware/validate';
import { createOffice, listOffices, updateOffice } from '../services/offices.service';
import { listProductCodes } from '../services/products.service';

/**
 * Offices (ADR-028): every signed-in user can read them (the office switcher needs the
 * list); only the Admin creates or edits them. Product codes ride along here — they are
 * shared reference data, like offices, needed by pickers on several pages.
 */
export function officesRoutes(): Router {
  const router = Router();
  router.param('id', idParamGuard);

  router.get('/', requireAuth, (req, res) => {
    res.json({ items: listOffices(getDb(), req.query.includeInactive === '1') });
  });

  router.post('/', requireRole('admin'), validateBody(officeSchema), (req, res) => {
    const result = createOffice(getDb(), req.body, req.user!.id, req.ip ?? null);
    res.status(result.ok ? 201 : result.code).json(result.ok ? { id: result.id } : { error: result.error });
  });

  const updateSchema = officeSchema.extend({ isActive: z.boolean().optional() });
  router.put('/:id', requireRole('admin'), validateBody(updateSchema), (req, res) => {
    const result = updateOffice(getDb(), Number(req.params.id), req.body, req.user!.id, req.ip ?? null);
    res.status(result.ok ? 200 : result.code).json(result.ok ? { ok: true } : { error: result.error });
  });

  return router;
}

/** Product codes in use (created at cutting) — for job issue / dispatch / filter pickers. */
export function productsRoutes(): Router {
  const router = Router();
  router.get('/', requireAuth, (_req, res) => {
    res.json({ items: listProductCodes(getDb()) });
  });
  return router;
}
