import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';

export type Db = Database.Database;

let instance: Db | null = null;

export function openDatabase(file: string): Db {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  // Office PC has no UPS — pay the (tiny, at this write volume) cost for power-loss durability.
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

/** The single app-wide connection (one process, one connection — see ARCHITECTURE.md). */
export function getDb(): Db {
  if (!instance) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    instance = openDatabase(path.join(config.dataDir, 'app.db'));
  }
  return instance;
}

export function closeDb(): void {
  if (instance) {
    // Flush the WAL into the main file so plain file copies (supervisor backup) are complete.
    try {
      instance.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      /* best effort */
    }
    instance.close();
    instance = null;
  }
}

/** ISO-8601 UTC now — the only timestamp format stored. */
export function nowIso(): string {
  return new Date().toISOString();
}
