import fs from 'node:fs';
import path from 'node:path';
import cron from 'node-cron';
import { getDb } from '../db/connection';
import { activeDataDir } from '../db/dataDirs';

const KEEP_DAILY = 30;

function backupsDir(): string {
  // follows the ACTIVE data dir, so demo-mode backups stay inside the demo folder
  const dir = path.join(activeDataDir(), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Online, WAL-consistent backup via SQLite's backup API — safe while serving. */
export async function runBackup(prefix = 'daily'): Promise<string> {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const file = path.join(backupsDir(), `${prefix}-${stamp}.db`);
  await getDb().backup(file);
  pruneBackups(prefix);
  return path.basename(file);
}

function pruneBackups(prefix: string): void {
  const dir = backupsDir();
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${prefix}-`) && f.endsWith('.db'))
    .sort()
    .reverse();
  for (const f of files.slice(KEEP_DAILY)) {
    fs.rmSync(path.join(dir, f), { force: true });
  }
}

export type BackupInfo = { name: string; sizeBytes: number; modifiedAt: string };

export function listBackups(): BackupInfo[] {
  const dir = backupsDir();
  const out: BackupInfo[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith('.db')) {
      const st = fs.statSync(full);
      out.push({ name: entry.name, sizeBytes: st.size, modifiedAt: st.mtime.toISOString() });
    } else if (entry.isDirectory()) {
      // pre-update-<version>/ folders written by the supervisor
      const inner = path.join(full, 'app.db');
      if (fs.existsSync(inner)) {
        const st = fs.statSync(inner);
        out.push({
          name: `${entry.name}/app.db`,
          sizeBytes: st.size,
          modifiedAt: st.mtime.toISOString(),
        });
      }
    }
  }
  return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

export function backupFilePath(name: string): string | null {
  // names come from listBackups(): either "daily-....db" or "pre-update-vX/app.db"
  const safe = path.normalize(name).replace(/^([.][.][/\\])+/, '');
  const full = path.join(backupsDir(), safe);
  if (!full.startsWith(backupsDir()) || !fs.existsSync(full)) return null;
  return full;
}

export function startBackupCron(): void {
  // 02:00 IST daily
  cron.schedule('0 2 * * *', () => void runBackup().catch((e) => console.error('[backup]', e)), {
    timezone: 'Asia/Kolkata',
  });
}
