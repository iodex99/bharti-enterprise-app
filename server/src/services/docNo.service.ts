import type { Db } from '../db/connection';
import { formatDocNo, type DocFamily } from '@shared';
import type { Office } from './offices.service';

/**
 * Allocate the next document number for a family (RM-0001, JOB-0042, ...).
 * MUST run inside the caller's transaction — the counter increment and the row
 * that uses the number commit together, so numbers have no gaps on failure.
 *
 * Each office runs its OWN series (ADR-028). Office 1 keeps the original plain
 * numbers; any other office gets its code embedded ("BR-RM-0001") because every
 * doc_no column is UNIQUE across the whole database.
 */
export function nextDocNo(db: Db, family: DocFamily, office: Office): string {
  const key = office.id === 1 ? family : `${family}@${office.id}`;
  db.prepare(
    `INSERT INTO counters (key, value) VALUES (?, 1)
     ON CONFLICT(key) DO UPDATE SET value = value + 1`,
  ).run(key);
  const row = db.prepare('SELECT value FROM counters WHERE key = ?').get(key) as {
    value: number;
  };
  return formatDocNo(family, row.value, office.id === 1 ? undefined : office.code);
}
