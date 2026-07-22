import type { Db } from '../db/connection';
import { audit } from './audit.service';

/**
 * First-run setup gate. A brand-new install (no business data recorded, and the admin
 * has not yet chosen) shows a one-question wizard: start fresh, or restore a backup from
 * the old computer. Existing installs — anything with real data — never see it.
 */

function isEmptyBusiness(db: Db): boolean {
  for (const table of ['purchases', 'opening_balances', 'job_cards']) {
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    if (n > 0) return false;
  }
  return true;
}

function flagSet(db: Db): boolean {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'setup_complete'")
    .get() as { value: string } | undefined;
  return row?.value === '1';
}

export function setupState(db: Db): { needsSetup: boolean } {
  // Needs setup only if nobody has dismissed the wizard AND there is no business data yet.
  return { needsSetup: !flagSet(db) && isEmptyBusiness(db) };
}

export function markSetupComplete(db: Db, userId: number, ip: string | null): void {
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO settings (key, value, updated_by) VALUES ('setup_complete', '1', ?)
       ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_by = excluded.updated_by`,
    ).run(userId);
    audit(db, { userId, action: 'setup_complete', entityType: 'system', ip });
  });
  tx();
}
