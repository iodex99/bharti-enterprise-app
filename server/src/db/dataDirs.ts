import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';

/**
 * Runtime switch between the REAL data directory and the DEMO one.
 *
 * - Real data lives in config.dataDir (e.g. C:\bharti\data).
 * - Demo data lives in a SIBLING directory `<dataDir>-demo` — a physically separate
 *   SQLite file + uploads + backups, so demo activity can never touch real records.
 * - The mode survives restarts via a flag file INSIDE the real data dir, and is
 *   read once at boot (before the first DB open).
 */

export const REAL_DATA_DIR = config.dataDir;
export const DEMO_DATA_DIR = `${config.dataDir}-demo`;
const FLAG_FILE = path.join(REAL_DATA_DIR, 'demo-mode.flag');

let demoActive = false;
let bootChecked = false;

function checkBootFlag(): void {
  if (bootChecked) return;
  bootChecked = true;
  try {
    demoActive =
      fs.existsSync(FLAG_FILE) && fs.existsSync(path.join(DEMO_DATA_DIR, 'app.db'));
  } catch {
    demoActive = false;
  }
}

export function isDemoMode(): boolean {
  checkBootFlag();
  return demoActive;
}

/** Every data-dir consumer (DB, uploads, backups) resolves through this. */
export function activeDataDir(): string {
  checkBootFlag();
  return demoActive ? DEMO_DATA_DIR : REAL_DATA_DIR;
}

export function demoDatabaseExists(): boolean {
  return fs.existsSync(path.join(DEMO_DATA_DIR, 'app.db'));
}

/** Called by the demo service AFTER the current DB connection is closed. */
export function setDemoMode(active: boolean): void {
  checkBootFlag();
  demoActive = active;
  fs.mkdirSync(REAL_DATA_DIR, { recursive: true });
  if (active) {
    fs.writeFileSync(FLAG_FILE, `demo mode since ${new Date().toISOString()}\n`);
  } else {
    fs.rmSync(FLAG_FILE, { force: true });
  }
}
