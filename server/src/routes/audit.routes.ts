import { Router } from 'express';
import { getDb } from '../db/connection';
import { requireRole } from '../middleware/auth';

type AuditRow = {
  id: number;
  user_id: number | null;
  username: string | null;
  action: string;
  entity_type: string;
  entity_id: number | null;
  old_json: string | null;
  new_json: string | null;
  ip: string | null;
  at: string;
};

export function auditRoutes(): Router {
  const router = Router();
  router.use(requireRole('admin'));

  router.get('/', (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);
    const entityType = typeof req.query.entityType === 'string' ? req.query.entityType : null;
    const entityId = req.query.entityId ? Number(req.query.entityId) : null;

    const where: string[] = [];
    const params: unknown[] = [];
    if (entityType) {
      where.push('a.entity_type = ?');
      params.push(entityType);
    }
    if (entityId) {
      where.push('a.entity_id = ?');
      params.push(entityId);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows = getDb()
      .prepare(
        `SELECT a.*, u.username FROM audit_log a
         LEFT JOIN users u ON u.id = a.user_id
         ${whereSql}
         ORDER BY a.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as AuditRow[];

    res.json({
      entries: rows.map((r) => ({
        id: r.id,
        user: r.username,
        action: r.action,
        entityType: r.entity_type,
        entityId: r.entity_id,
        old: r.old_json ? JSON.parse(r.old_json) : null,
        new: r.new_json ? JSON.parse(r.new_json) : null,
        ip: r.ip,
        at: r.at,
      })),
    });
  });

  return router;
}
