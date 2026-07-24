import type { NextFunction, Request, Response } from 'express';
import { getDb } from '../db/connection';
import { getOffice, type Office } from '../services/offices.service';

declare module 'express-serve-static-core' {
  interface Request {
    /** The office this request operates in (set by resolveOffice for signed-in users). */
    office?: Office;
  }
}

/**
 * Resolve the request's office (ADR-028):
 *  - operators are PINNED to their own office — the header cannot override it;
 *  - admin/owner work in the office selected in the UI (X-Office-Id header),
 *    falling back to office 1.
 * Runs after attachUser; requests without a user pass through (auth rejects later).
 */
export function resolveOffice(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    next();
    return;
  }
  const db = getDb();

  if (req.user.role === 'operator') {
    const own = (
      db.prepare('SELECT office_id AS officeId FROM users WHERE id = ?').get(req.user.id) as
        | { officeId: number | null }
        | undefined
    )?.officeId;
    const office = own ? getOffice(db, own) : null;
    if (!office || !office.isActive) {
      res.status(403).json({
        error: 'Your account is not assigned to an active office — ask the Admin to set it.',
      });
      return;
    }
    req.office = office;
    next();
    return;
  }

  const header = req.header('X-Office-Id');
  const wanted = header && /^\d{1,9}$/.test(header) ? Number(header) : 1;
  const office = getOffice(db, wanted);
  if (!office || !office.isActive) {
    res.status(400).json({ error: 'That office does not exist or is deactivated.' });
    return;
  }
  req.office = office;
  next();
}

/** For handlers that KNOW auth ran: the resolved office, never undefined. */
export function officeOf(req: Request): Office {
  if (!req.office) throw new Error('resolveOffice did not run before this handler');
  return req.office;
}
