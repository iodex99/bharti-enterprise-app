import type { NextFunction, Request, Response } from 'express';
import { getDb } from '../db/connection';

/**
 * Double-submit protection for document-creating POSTs. Clients send a random
 * `Idempotency-Key` header per form submission; a retry (double-click, flaky network,
 * impatient refresh) replays the original result instead of creating a duplicate.
 *
 * Services record the key inside their transaction via recordIdempotency().
 */
export function idempotencyGuard(entityType: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.header('Idempotency-Key');
    if (!key) {
      next(); // optional — tests/scripts may post without it
      return;
    }
    if (key.length > 100) {
      res.status(400).json({ error: 'Idempotency-Key too long.' });
      return;
    }
    const existing = getDb()
      .prepare('SELECT entity_type, entity_id FROM idempotency_keys WHERE key = ?')
      .get(key) as { entity_type: string; entity_id: number } | undefined;
    if (existing) {
      // A replay only means anything for the SAME kind of document. A key reused across
      // routes is a client bug, not a retry — never hand back another entity's id.
      if (existing.entity_type !== entityType) {
        res.status(409).json({ error: 'This Idempotency-Key was already used for a different document.' });
        return;
      }
      res.status(200).json({ id: existing.entity_id, replayed: true });
      return;
    }
    res.locals.idempotencyKey = key;
    res.locals.idempotencyEntityType = entityType;
    next();
  };
}

/** Call inside the same transaction that creates the entity. */
export function recordIdempotency(
  db: import('../db/connection').Db,
  res: Response,
  entityId: number,
): void {
  const key = res.locals.idempotencyKey as string | undefined;
  const entityType = res.locals.idempotencyEntityType as string | undefined;
  if (key && entityType) {
    db.prepare(
      'INSERT INTO idempotency_keys (key, entity_type, entity_id) VALUES (?, ?, ?)',
    ).run(key, entityType, entityId);
  }
}
