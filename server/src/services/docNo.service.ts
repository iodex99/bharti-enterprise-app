import type { Db } from '../db/connection';
import { formatDocNo, type DocFamily } from '@shared';

/**
 * Allocate the next document number for a family (RM-0001, JOB-0042, …).
 * MUST run inside the caller's transaction — the counter increment and the row
 * that uses the number commit together, so numbers have no gaps on failure.
 */
export function nextDocNo(db: Db, family: DocFamily): string {
  db.prepare(
    `INSERT INTO counters (key, value) VALUES (?, 1)
     ON CONFLICT(key) DO UPDATE SET value = value + 1`,
  ).run(family);
  const row = db.prepare('SELECT value FROM counters WHERE key = ?').get(family) as {
    value: number;
  };
  return formatDocNo(family, row.value);
}
