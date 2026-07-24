import fs from 'node:fs';
import path from 'node:path';
import { closeDb, getDb, openDatabase } from '../db/connection';
import {
  DEMO_DATA_DIR,
  demoDatabaseExists,
  isDemoMode,
  setDemoMode,
} from '../db/dataDirs';
import { migrate } from '../db/migrate';
import { populateDemo } from '../db/demo-data';
import { audit } from './audit.service';

/**
 * In-app demo mode (admin-only). The demo is a physically separate database at
 * <dataDir>-demo; entering/leaving swaps the single app connection between files.
 * Real data is never read or written while demo mode is active.
 */

export type DemoStatus = {
  active: boolean;
  demoExists: boolean;
  demoDir: string;
};

export function demoStatus(): DemoStatus {
  return { active: isDemoMode(), demoExists: demoDatabaseExists(), demoDir: DEMO_DATA_DIR };
}

export type DemoResult = { ok: true } | { ok: false; code: number; error: string };

/** Build (or rebuild) the demo database on a temporary connection. */
function buildDemoDatabase(): void {
  fs.rmSync(DEMO_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DEMO_DATA_DIR, { recursive: true });
  const demoDb = openDatabase(path.join(DEMO_DATA_DIR, 'app.db'));
  try {
    migrate(demoDb);
    const reconciliation = populateDemo(demoDb);
    if (!reconciliation.ok) {
      throw new Error('Demo data failed its own conservation checks — aborting.');
    }
  } catch (err) {
    demoDb.close();
    fs.rmSync(DEMO_DATA_DIR, { recursive: true, force: true });
    throw err;
  }
  demoDb.close();
}

export function enterDemoMode(fresh: boolean, userId: number, ip: string | null): DemoResult {
  if (isDemoMode()) return { ok: false, code: 409, error: 'Demo mode is already active.' };

  // record who started the demo IN THE REAL DB before switching away from it
  audit(getDb(), { userId, action: 'demo_enter', entityType: 'system', ip });

  if (fresh || !demoDatabaseExists()) {
    buildDemoDatabase();
  } else {
    // an existing demo db may be from an older app version — bring its schema up to
    // date BEFORE swapping to it, or every request would 500 on the missing tables
    const demoDb = openDatabase(path.join(DEMO_DATA_DIR, 'app.db'));
    try {
      migrate(demoDb);
    } finally {
      demoDb.close();
    }
  }
  closeDb();
  setDemoMode(true);
  getDb(); // open the demo connection immediately so the first request isn't slow
  return { ok: true };
}

export function exitDemoMode(): DemoResult {
  if (!isDemoMode()) return { ok: false, code: 409, error: 'Demo mode is not active.' };
  closeDb();
  setDemoMode(false);
  const db = getDb(); // back on the real database
  // the demo admin's action can't be attributed to a real user id — log as system
  audit(db, { userId: null, action: 'demo_exit', entityType: 'system' });
  return { ok: true };
}

export function removeDemoData(userId: number, ip: string | null): DemoResult {
  if (isDemoMode()) {
    return { ok: false, code: 409, error: 'Exit demo mode first, then remove the demo data.' };
  }
  if (!demoDatabaseExists()) return { ok: false, code: 404, error: 'There is no demo data.' };
  fs.rmSync(DEMO_DATA_DIR, { recursive: true, force: true });
  audit(getDb(), { userId, action: 'demo_remove', entityType: 'system', ip });
  return { ok: true };
}
