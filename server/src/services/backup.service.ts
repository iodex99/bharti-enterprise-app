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
  mirrorQuietly(getDb());
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

// ---------------------------------------------------------------------------
// cloud mirror: copy backups into a folder synced by Google Drive for Desktop /
// OneDrive / Dropbox. The sync app (signed in with the owner's email) does the
// uploading — no Google API keys or OAuth tokens to manage or expire.
// ---------------------------------------------------------------------------

export function cloudBackupDir(db: import('../db/connection').Db): string | null {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'cloud_backup_dir'")
    .get() as { value: string } | undefined;
  const dir = row?.value?.trim();
  return dir ? dir : null;
}

export type CloudMirrorResult =
  | { ok: true; dir: string; copied: number; total: number }
  | { ok: false; error: string };

/** Copy any backup files missing from the cloud folder; keep the newest 30 there. */
export function mirrorToCloud(db: import('../db/connection').Db): CloudMirrorResult {
  const dir = cloudBackupDir(db);
  if (!dir) return { ok: false, error: 'No cloud backup folder is configured.' };
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return { ok: false, error: `Cannot create or access the folder: ${dir}` };
  }
  try {
    const source = backupsDir();
    const files = fs
      .readdirSync(source)
      .filter((f) => f.endsWith('.db') && (f.startsWith('daily-') || f.startsWith('manual-')));
    let copied = 0;
    for (const file of files) {
      const dest = path.join(dir, file);
      if (!fs.existsSync(dest)) {
        fs.copyFileSync(path.join(source, file), dest);
        copied++;
      }
    }
    // prune the mirror to the newest 30 backup files
    const mirrored = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.db') && (f.startsWith('daily-') || f.startsWith('manual-')))
      .sort()
      .reverse();
    for (const f of mirrored.slice(KEEP_DAILY)) fs.rmSync(path.join(dir, f), { force: true });
    return { ok: true, dir, copied, total: Math.min(mirrored.length, KEEP_DAILY) };
  } catch (err) {
    return { ok: false, error: `Copy failed: ${(err as Error).message}` };
  }
}

/** Best-effort mirror after each backup — a broken cloud folder must never break backups. */
export function mirrorQuietly(db: import('../db/connection').Db): void {
  if (!cloudBackupDir(db)) return;
  const result = mirrorToCloud(db);
  if (!result.ok) console.warn('[backup] cloud mirror failed:', result.error);
}
