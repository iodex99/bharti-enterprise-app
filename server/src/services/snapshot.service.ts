import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import AdmZip from 'adm-zip';
import { config } from '../config';
import { REAL_DATA_DIR } from '../db/dataDirs';
import { closeDb, getDb, openDatabase } from '../db/connection';
import { knownMigrationNames, migrate } from '../db/migrate';
import { runReconciliation } from './reconciliation.service';
import { cloudBackupDir } from './backup.service';
import { audit } from './audit.service';

/**
 * Complete backup ("snapshot") = ONE portable .zip carrying the whole business:
 * the database + every uploaded photo + a manifest. This is the migration unit —
 * download it on the old PC, restore it on the new one and nothing is left behind.
 *
 * Restore reuses the same runtime connection-swap the demo mode uses (close → replace
 * files → reopen), wrapped so the swap is FULLY SYNCHRONOUS: the Node event loop is
 * blocked start-to-finish, so no request can ever observe a half-swapped data dir.
 * The pre-restore state is copied aside first and put back automatically on any failure.
 */

const SNAPSHOT_APP = 'bharti-enterprise';
const SNAPSHOT_KIND = 'complete-backup';
const MANIFEST_NAME = 'manifest.json';

export type SnapshotManifest = {
  app: typeof SNAPSHOT_APP;
  kind: typeof SNAPSHOT_KIND;
  appVersion: string;
  createdAt: string;
  migrations: string[];
  counts: { users: number; purchases: number; jobCards: number; uploads: number };
};

function realDbPath(): string {
  return path.join(REAL_DATA_DIR, 'app.db');
}
function realUploadsDir(): string {
  return path.join(REAL_DATA_DIR, 'uploads');
}

function countRows(db: import('../db/connection').Db, table: string): number {
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  } catch {
    return 0;
  }
}

function countUploads(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const month of fs.readdirSync(dir)) {
    const monthDir = path.join(dir, month);
    if (fs.statSync(monthDir).isDirectory()) {
      n += fs.readdirSync(monthDir).filter((f) => f.endsWith('.webp')).length;
    }
  }
  return n;
}

/** Assemble the in-memory zip of the REAL data (DB + photos + manifest). Real data only. */
function assembleSnapshot(): { zip: AdmZip; manifest: SnapshotManifest } {
  const db = getDb();
  // flush WAL so the app.db file on disk is complete before we copy it
  db.pragma('wal_checkpoint(TRUNCATE)');

  const manifest: SnapshotManifest = {
    app: SNAPSHOT_APP,
    kind: SNAPSHOT_KIND,
    appVersion: config.version,
    createdAt: new Date().toISOString(),
    migrations: (
      db.prepare('SELECT name FROM schema_migrations ORDER BY name').all() as { name: string }[]
    ).map((r) => r.name),
    counts: {
      users: countRows(db, 'users'),
      purchases: countRows(db, 'purchases'),
      jobCards: countRows(db, 'job_cards'),
      uploads: countUploads(realUploadsDir()),
    },
  };

  const zip = new AdmZip();
  zip.addFile(MANIFEST_NAME, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  zip.addLocalFile(realDbPath(), '', 'app.db');
  if (fs.existsSync(realUploadsDir())) {
    zip.addLocalFolder(realUploadsDir(), 'uploads');
  }
  return { zip, manifest };
}

/** Build a complete snapshot of the REAL data into destZip (used by cloud send). */
export function buildSnapshot(destZip: string): SnapshotManifest {
  const { zip, manifest } = assembleSnapshot();
  fs.mkdirSync(path.dirname(destZip), { recursive: true });
  zip.writeZip(destZip);
  return manifest;
}

/** Build a complete snapshot as an in-memory buffer (used by the download endpoint — no
 * temp file to race a streaming response against). */
export function buildSnapshotBuffer(): { manifest: SnapshotManifest; buffer: Buffer } {
  const { zip, manifest } = assembleSnapshot();
  return { manifest, buffer: zip.toBuffer() };
}

export type InspectResult =
  | { ok: true; manifest: SnapshotManifest; compatible: boolean; warning?: string }
  | { ok: false; error: string };

/** Parse + validate a snapshot zip WITHOUT touching live data. */
export function inspectSnapshot(zipPath: string): InspectResult {
  let zip: AdmZip;
  try {
    zip = new AdmZip(zipPath);
  } catch {
    return { ok: false, error: 'This file is not a valid backup (could not read the zip).' };
  }
  const manifestEntry = zip.getEntry(MANIFEST_NAME);
  const dbEntry = zip.getEntry('app.db');
  if (!manifestEntry || !dbEntry) {
    return { ok: false, error: 'This zip is not a Bharti complete backup (missing manifest or database).' };
  }
  let manifest: SnapshotManifest;
  try {
    manifest = JSON.parse(zip.readAsText(manifestEntry)) as SnapshotManifest;
  } catch {
    return { ok: false, error: 'The backup manifest is unreadable.' };
  }
  if (manifest.app !== SNAPSHOT_APP || manifest.kind !== SNAPSHOT_KIND) {
    return { ok: false, error: 'This backup was not created by this system.' };
  }
  // Version compatibility: additive migrations are forward-only, so an OLDER backup is
  // fine (we migrate it up), but a backup from a NEWER app version carries migrations
  // this build can't run — refuse rather than corrupt.
  const known = new Set(knownMigrationNames());
  const future = (manifest.migrations ?? []).filter((m) => !known.has(m));
  if (future.length > 0) {
    return {
      ok: true,
      manifest,
      compatible: false,
      warning: `This backup is from a newer version of the app (${manifest.appVersion}). Update this computer's app first, then restore.`,
    };
  }
  return { ok: true, manifest, compatible: true };
}

export type RestoreResult = { ok: true; manifest: SnapshotManifest } | { ok: false; code: number; error: string };

function stagingRoot(): string {
  return path.join(REAL_DATA_DIR, 'restore-staging');
}

/** Where an uploaded restore file is parked between /upload and /commit. Hex token only. */
export function stagedUploadPath(token: string): string | null {
  if (!/^[a-f0-9]{8,64}$/.test(token)) return null;
  return path.join(stagingRoot(), `${token}.zip`);
}
export function newUploadToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

function rmQuiet(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
}
function moveIfExists(from: string, to: string): void {
  if (fs.existsSync(from)) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
  }
}

/**
 * Replace ALL real data with the contents of a snapshot zip. Synchronous end-to-end so
 * the swap is atomic w.r.t. other requests. Caller MUST ensure demo mode is off.
 */
export function restoreSnapshot(zipPath: string, userId: number | null, ip: string | null): RestoreResult {
  const inspected = inspectSnapshot(zipPath);
  if (!inspected.ok) return { ok: false, code: 400, error: inspected.error };
  if (!inspected.compatible) return { ok: false, code: 400, error: inspected.warning! };
  const manifest = inspected.manifest;

  // 1) extract to a staging dir (no live data touched yet)
  const staging = path.join(stagingRoot(), `x-${crypto.randomBytes(6).toString('hex')}`);
  try {
    new AdmZip(zipPath).extractAllTo(staging, true);
  } catch {
    rmQuiet(staging);
    return { ok: false, code: 400, error: 'Could not unpack the backup file.' };
  }
  const stagedDb = path.join(staging, 'app.db');
  const stagedUploads = path.join(staging, 'uploads');
  if (!fs.existsSync(stagedDb)) {
    rmQuiet(staging);
    return { ok: false, code: 400, error: 'The backup is missing its database.' };
  }
  // sanity: the staged DB must open and carry the schema
  try {
    const probe = openDatabase(stagedDb);
    const ok = probe.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get() as { n: number };
    probe.close();
    if (ok.n < 2) throw new Error('empty');
    // drop any WAL sidecars from the probe so the file we copy in is self-contained
    for (const s of ['-wal', '-shm']) rmQuiet(stagedDb + s);
  } catch {
    rmQuiet(staging);
    return { ok: false, code: 400, error: 'The backup database could not be opened.' };
  }

  // 2) --- SYNCHRONOUS CRITICAL SECTION: no awaits, so no request can interleave ---
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safety = path.join(REAL_DATA_DIR, 'backups', `pre-restore-${stamp}`);
  const liveDb = realDbPath();
  const liveUploads = realUploadsDir();
  try {
    closeDb();
    fs.mkdirSync(safety, { recursive: true });
    // move current state aside (recoverable)
    moveIfExists(liveDb, path.join(safety, 'app.db'));
    for (const s of ['-wal', '-shm']) rmQuiet(liveDb + s);
    moveIfExists(liveUploads, path.join(safety, 'uploads'));
    // put the snapshot in place
    fs.copyFileSync(stagedDb, liveDb);
    if (fs.existsSync(stagedUploads)) moveIfExists(stagedUploads, liveUploads);

    const db = getDb(); // reopen on the restored database
    migrate(db, liveDb); // forward-migrate an older backup, if needed
    const rec = runReconciliation(db);
    if (!rec.ok) throw new Error('restored data failed its integrity checks');

    // Force everyone to sign in again against the restored data — the snapshot may carry
    // its own (now meaningless) sessions, and the valid set of users may have changed.
    db.prepare('DELETE FROM sessions').run();

    // Audited as a SYSTEM event: the acting admin's id belongs to the OLD database and
    // may not exist in the restored users table (audit_log.user_id is a FK). Record the
    // actor inside the payload instead so the FK insert can never fail the restore.
    audit(db, {
      userId: null,
      action: 'data_restore',
      entityType: 'system',
      new: {
        appVersion: manifest.appVersion,
        createdAt: manifest.createdAt,
        counts: manifest.counts,
        safety: path.basename(safety),
        restoredByUserId: userId,
      },
      ip,
    });
  } catch (err) {
    // 3) rollback: put the pre-restore state back
    try {
      closeDb();
      rmQuiet(liveDb);
      for (const s of ['-wal', '-shm']) rmQuiet(liveDb + s);
      rmQuiet(liveUploads);
      moveIfExists(path.join(safety, 'app.db'), liveDb);
      moveIfExists(path.join(safety, 'uploads'), liveUploads);
      rmQuiet(safety);
      getDb();
    } catch (rollbackErr) {
      console.error('[restore] ROLLBACK FAILED — safety copy kept at', safety, rollbackErr);
      rmQuiet(staging);
      return {
        ok: false,
        code: 500,
        error: `Restore failed AND automatic rollback failed. Your previous data is safe in backups/${path.basename(safety)} — contact support before making changes.`,
      };
    }
    rmQuiet(staging);
    console.error('[restore] failed, rolled back to previous data:', err);
    return { ok: false, code: 400, error: `Restore failed: ${(err as Error).message}. Your previous data was put back unchanged.` };
  }

  rmQuiet(staging);
  console.log(`[restore] complete — restored backup from ${manifest.createdAt} (${manifest.appVersion})`);
  return { ok: true, manifest };
}

const CLOUD_SNAPSHOT_PREFIX = 'complete-';
const KEEP_CLOUD_SNAPSHOTS = 5;

export type CloudSendResult =
  | { ok: true; name: string; dir: string }
  | { ok: false; code: number; error: string };

/** Build a complete snapshot straight into the Google-Drive-synced folder for migration. */
export function sendCompleteSnapshotToCloud(db: import('../db/connection').Db): CloudSendResult {
  const dir = cloudBackupDir(db);
  if (!dir) return { ok: false, code: 400, error: 'Set the cloud backup folder first (above).' };
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return { ok: false, code: 400, error: `Cannot access the cloud folder: ${dir}` };
  }
  const date = new Date().toISOString().slice(0, 10);
  const name = `${CLOUD_SNAPSHOT_PREFIX}${date}.zip`;
  buildSnapshot(path.join(dir, name));
  // keep only the newest few complete snapshots in the cloud folder
  const zips = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(CLOUD_SNAPSHOT_PREFIX) && f.endsWith('.zip'))
    .sort()
    .reverse();
  for (const f of zips.slice(KEEP_CLOUD_SNAPSHOTS)) rmQuiet(path.join(dir, f));
  return { ok: true, name, dir };
}

export type CloudSnapshot = { name: string; sizeBytes: number; modifiedAt: string; manifest: SnapshotManifest | null };

/** Complete snapshots sitting in the cloud folder (for restore on a new PC). */
export function listCloudSnapshots(db: import('../db/connection').Db): { cloudDir: string | null; items: CloudSnapshot[] } {
  const dir = cloudBackupDir(db);
  if (!dir || !fs.existsSync(dir)) return { cloudDir: dir, items: [] };
  const items: CloudSnapshot[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(CLOUD_SNAPSHOT_PREFIX) || !name.endsWith('.zip')) continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    const inspected = inspectSnapshot(full);
    items.push({
      name,
      sizeBytes: st.size,
      modifiedAt: st.mtime.toISOString(),
      manifest: inspected.ok ? inspected.manifest : null,
    });
  }
  items.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return { cloudDir: dir, items };
}

/** Resolve a cloud snapshot name to its absolute path (guards traversal). */
export function cloudSnapshotPath(db: import('../db/connection').Db, name: string): string | null {
  const dir = cloudBackupDir(db);
  if (!dir) return null;
  if (!/^complete-[\w.-]+\.zip$/.test(name)) return null;
  const full = path.join(dir, path.basename(name));
  if (!fs.existsSync(full)) return null;
  return full;
}

/** Best-effort sweep of stale staging files (called opportunistically). */
export function cleanupStaging(): void {
  try {
    const root = stagingRoot();
    if (!fs.existsSync(root)) return;
    const cutoff = Date.now() - 6 * 3600 * 1000;
    for (const entry of fs.readdirSync(root)) {
      const full = path.join(root, entry);
      if (fs.statSync(full).mtimeMs < cutoff) rmQuiet(full);
    }
  } catch {
    /* best effort */
  }
}
