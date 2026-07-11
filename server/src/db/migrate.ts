import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './connection';
import { activeDataDir } from './dataDirs';

/**
 * Transactional, additive-only migration runner.
 * - migrations/ sits next to this module: server/src/db/migrations in dev,
 *   server/dist/migrations in the release (copied there by build.mjs).
 * - Each NNN_name.sql runs inside one transaction; failure -> throw (boot aborts
 *   with exit 43 so the supervisor can roll back the release).
 * - Before applying anything to an existing production DB, a plain pre-migrate
 *   backup copy is written (the app is single-process and hasn't opened writes yet).
 */

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export function pendingMigrations(db: Db): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  const applied = new Set(
    (db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
  return fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => !applied.has(f));
}

export function migrate(db: Db, dbFilePath?: string): string[] {
  const pending = pendingMigrations(db);
  if (pending.length === 0) return [];

  // Pre-migrate safety copy of a non-empty database.
  if (dbFilePath && fs.existsSync(dbFilePath)) {
    const hasTables =
      (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get() as {
        n: number;
      }).n > 1;
    if (hasTables) {
      const backupDir = path.join(activeDataDir(), 'backups');
      fs.mkdirSync(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      db.pragma('wal_checkpoint(TRUNCATE)');
      fs.copyFileSync(dbFilePath, path.join(backupDir, `pre-migrate-${stamp}.db`));
    }
  }

  for (const name of pending) {
    const sql = fs.readFileSync(path.join(migrationsDir, name), 'utf8');
    console.log(`[migrate] applying ${name}`);
    const run = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(name);
    });
    run();
  }
  return pending;
}
