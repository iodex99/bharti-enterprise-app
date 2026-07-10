import { Router } from 'express';
import { getDb } from '../db/connection';
import { requireAuth, requireRole } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import {
  createMaster,
  listMaster,
  MASTERS,
  setMasterActive,
  softDeleteMaster,
  updateMaster,
  type MasterKey,
} from '../services/masters.service';

/**
 * /api/masters/:master — GET for every signed-in role (owners read masters),
 * mutations admin-only per spec ("Admin: manage masters"). Soft delete admin-only and
 * blocked while referenced; deactivate hides from new-use dropdowns.
 */
export function mastersRoutes(): Router {
  const router = Router();

  for (const [key, cfg] of Object.entries(MASTERS) as [MasterKey, (typeof MASTERS)[MasterKey]][]) {
    const sub = Router();

    sub.get('/', requireAuth, (req, res) => {
      const q = typeof req.query.q === 'string' ? req.query.q : undefined;
      const includeInactive = req.query.includeInactive === '1';
      res.json({ items: listMaster(cfg, getDb(), { q, includeInactive }) });
    });

    sub.post('/', requireRole('admin'), validateBody(cfg.schema), (req, res) => {
      const result = createMaster(cfg, getDb(), req.body, req.user!.id, req.ip ?? null);
      if (!result.ok) {
        res.status(result.code).json({ error: result.error });
        return;
      }
      res.status(201).json({ id: result.id });
    });

    sub.put('/:id', requireRole('admin'), validateBody(cfg.schema), (req, res) => {
      const result = updateMaster(
        cfg,
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
      res.json({ ok: true });
    });

    sub.post('/:id/deactivate', requireRole('admin'), (req, res) => {
      const result = setMasterActive(
        cfg,
        getDb(),
        Number(req.params.id),
        false,
        req.user!.id,
        req.ip ?? null,
      );
      res.status(result.ok ? 200 : result.code).json(result.ok ? { ok: true } : { error: result.error });
    });

    sub.post('/:id/reactivate', requireRole('admin'), (req, res) => {
      const result = setMasterActive(
        cfg,
        getDb(),
        Number(req.params.id),
        true,
        req.user!.id,
        req.ip ?? null,
      );
      res.status(result.ok ? 200 : result.code).json(result.ok ? { ok: true } : { error: result.error });
    });

    sub.delete('/:id', requireRole('admin'), (req, res) => {
      const result = softDeleteMaster(
        cfg,
        getDb(),
        Number(req.params.id),
        req.user!.id,
        req.ip ?? null,
      );
      res.status(result.ok ? 200 : result.code).json(result.ok ? { ok: true } : { error: result.error });
    });

    router.use(`/${key}`, sub);
  }

  return router;
}
