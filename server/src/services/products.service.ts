import type { Db } from '../db/connection';

/**
 * Product identities (ADR-030). "Models" are no longer a master the admin maintains:
 * the CODE typed beside a size at cutting (or on an opening balance) IS the product,
 * and together with the size it reads as the "size-code" everywhere — e.g. code 315,
 * size L → "315-L". Under the hood codes live in the legacy `models` table so every
 * ledger dimension, report and trace keeps working unchanged.
 */

/**
 * Resolve a code to its model id, creating the row on first use. Re-typing a code that
 * was deactivated quietly reactivates it — the codes are system-managed now.
 * MUST run inside the caller's transaction when used during document creation.
 */
export function modelIdForCode(
  db: Db,
  code: string,
  userId: number,
  imagePath?: string | null,
): number {
  const existing = db
    .prepare('SELECT id, image_path, is_active FROM models WHERE code = ? COLLATE NOCASE')
    .get(code) as { id: number; image_path: string | null; is_active: number } | undefined;

  if (existing) {
    if (!existing.is_active) {
      db.prepare('UPDATE models SET is_active = 1, deleted_at = NULL WHERE id = ?').run(existing.id);
    }
    // the latest photo wins — the user uploads it right where they type the code
    if (imagePath && imagePath !== existing.image_path) {
      db.prepare('UPDATE models SET image_path = ? WHERE id = ?').run(imagePath, existing.id);
    }
    return existing.id;
  }

  const info = db
    .prepare('INSERT INTO models (code, name, image_path, created_by) VALUES (?, ?, ?, ?)')
    .run(code, code, imagePath ?? null, userId);
  return Number(info.lastInsertRowid);
}

/** All product codes in use (for pickers on job issue / dispatch / filters). */
export function listProductCodes(db: Db): Array<{ id: number; code: string; imagePath: string | null }> {
  return db
    .prepare(
      `SELECT id, code, image_path AS imagePath FROM models
       WHERE is_active = 1 AND deleted_at IS NULL AND code != 'RAW-CLOTH'
       ORDER BY code`,
    )
    .all() as Array<{ id: number; code: string; imagePath: string | null }>;
}
