import type { OfficeInput } from '@shared';
import type { Db } from '../db/connection';
import { audit } from './audit.service';

/**
 * Offices (ADR-028): the business runs from more than one office. Each office's
 * documents, stock and doc-number series are fully separate; masters and logins are
 * shared. The admin configures offices from the app; operators are pinned to one.
 */

export type Office = { id: number; code: string; name: string; isActive: number };

export function listOffices(db: Db, includeInactive = false): Office[] {
  return db
    .prepare(
      `SELECT id, code, name, is_active AS isActive FROM offices
       ${includeInactive ? '' : 'WHERE is_active = 1'} ORDER BY id`,
    )
    .all() as Office[];
}

export function getOffice(db: Db, id: number): Office | null {
  const row = db
    .prepare('SELECT id, code, name, is_active AS isActive FROM offices WHERE id = ?')
    .get(id) as Office | undefined;
  return row ?? null;
}

export type OfficeResult = { ok: true; id: number } | { ok: false; code: number; error: string };

export function createOffice(
  db: Db,
  input: OfficeInput,
  userId: number,
  ip: string | null,
): OfficeResult {
  const dupe = db
    .prepare('SELECT id FROM offices WHERE code = ? COLLATE NOCASE OR name = ? COLLATE NOCASE')
    .get(input.code, input.name);
  if (dupe) return { ok: false, code: 409, error: 'An office with that code or name exists.' };

  let id = 0;
  const tx = db.transaction(() => {
    const info = db
      .prepare('INSERT INTO offices (code, name, created_by) VALUES (?, ?, ?)')
      .run(input.code, input.name, userId);
    id = Number(info.lastInsertRowid);
    audit(db, { userId, action: 'create', entityType: 'office', entityId: id, new: input, ip });
  });
  tx();
  return { ok: true, id };
}

export function updateOffice(
  db: Db,
  id: number,
  input: OfficeInput & { isActive?: boolean },
  userId: number,
  ip: string | null,
): OfficeResult {
  const existing = getOffice(db, id);
  if (!existing) return { ok: false, code: 404, error: 'Office not found.' };
  if (id === 1 && input.isActive === false) {
    return { ok: false, code: 409, error: 'The first office cannot be deactivated.' };
  }
  const dupe = db
    .prepare(
      'SELECT id FROM offices WHERE (code = ? COLLATE NOCASE OR name = ? COLLATE NOCASE) AND id != ?',
    )
    .get(input.code, input.name, id);
  if (dupe) return { ok: false, code: 409, error: 'An office with that code or name exists.' };

  const tx = db.transaction(() => {
    db.prepare('UPDATE offices SET code = ?, name = ?, is_active = ? WHERE id = ?').run(
      input.code,
      input.name,
      input.isActive === false ? 0 : 1,
      id,
    );
    audit(db, {
      userId,
      action: 'update',
      entityType: 'office',
      entityId: id,
      old: existing,
      new: input,
      ip,
    });
  });
  tx();
  return { ok: true, id };
}
