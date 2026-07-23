import {
  checkForUpdate,
  dismissRollbackNotice,
  downloadApk,
  getUpdateStatus,
  startUpdate,
} from './updater';
import { getShell } from './shell';

/**
 * The handful of /api/system endpoints that are about the DEVICE rather than the data:
 * updates, backups, restore and demo mode. On the Node host these are Express routes
 * (routes/system.node.routes.ts); here they are answered on the UI thread, because they
 * need the app shell, the file system and the Android share sheet — none of which a
 * worker can reach.
 *
 * The paths and payloads match the server's exactly, so the pages, the update banner and
 * the backups screen are the same code on both.
 */

const NATIVE_PATHS = [
  '/api/system/update',
  '/api/system/update-status',
  '/api/system/update-check',
  '/api/system/update-apk',
  '/api/system/update-rollback-notice',
  '/api/system/backups',
  '/api/system/restore',
  '/api/system/demo',
];

export function isNativeOpPath(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return NATIVE_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

// -- backups -----------------------------------------------------------------

const BACKUP_INDEX_KEY = 'bharti.backups';
const KEEP_BACKUPS = 14;
const SQLITE_MAGIC = 'SQLite format 3\0';

type BackupEntry = { name: string; sizeBytes: number; modifiedAt: string };

function readBackupIndex(): BackupEntry[] {
  try {
    return JSON.parse(localStorage.getItem(BACKUP_INDEX_KEY) ?? '[]') as BackupEntry[];
  } catch {
    return [];
  }
}

function writeBackupIndex(entries: BackupEntry[]): void {
  localStorage.setItem(BACKUP_INDEX_KEY, JSON.stringify(entries.slice(0, KEEP_BACKUPS)));
}

function backupFileName(prefix: string): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `bharti-${prefix}-${stamp}.db`;
}

/**
 * A backup is the database file — and since migration 003 that file holds the photos
 * too, so one file really is the whole business. Kept in the app's private storage and
 * offered to the share sheet (Google Drive, WhatsApp, a cable) on request.
 */
export async function createBackup(prefix: 'daily' | 'manual'): Promise<BackupEntry> {
  const { exportDatabase } = await import('./bridge');
  const bytes = await exportDatabase();
  const name = backupFileName(prefix);
  await getShell().writePrivateFile(name, bytes);
  const entry: BackupEntry = {
    name,
    sizeBytes: bytes.byteLength,
    modifiedAt: new Date().toISOString(),
  };
  writeBackupIndex([entry, ...readBackupIndex()]);
  return entry;
}

export function lastDailyBackupDate(): string | null {
  const daily = readBackupIndex().find((entry) => entry.name.includes('-daily-'));
  return daily ? daily.modifiedAt.slice(0, 10) : null;
}

/** Take the day's backup if it hasn't been taken yet. Called at start-up and hourly. */
export async function runDailyBackupIfDue(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  if (lastDailyBackupDate() === today) return;
  try {
    await createBackup('daily');
  } catch (err) {
    console.warn('[backup] daily backup failed, will retry:', err);
  }
}

async function exportAndShare(): Promise<Response> {
  const { exportDatabase } = await import('./bridge');
  const bytes = await exportDatabase();
  const name = `bharti-complete-backup-${new Date().toISOString().slice(0, 10)}.db`;
  const shell = getShell();
  const { uri } = await shell.saveUserFile(name, bytes, 'application/vnd.sqlite3');
  try {
    await shell.shareFile(uri, 'Bharti complete backup');
  } catch {
    /* the user dismissed the share sheet — the file is still saved */
  }
  return json({ ok: true, name, sizeBytes: bytes.byteLength, uri });
}

// -- restore -----------------------------------------------------------------

const staged = new Map<string, Uint8Array>();

function inspectBackup(bytes: Uint8Array): { ok: true } | { ok: false; error: string } {
  if (bytes.byteLength < 100) return { ok: false, error: 'That file is too small to be a backup.' };
  const header = new TextDecoder('latin1').decode(bytes.subarray(0, 16));
  if (header !== SQLITE_MAGIC) {
    return {
      ok: false,
      error:
        'That file is not a Bharti backup. Choose the .db file the app produced with “Download complete backup”.',
    };
  }
  return { ok: true };
}

// -- dispatch ----------------------------------------------------------------

export async function handleNativeOp(
  url: string,
  method: string,
  init?: RequestInit,
): Promise<Response> {
  const path = url.split('?')[0] ?? '';
  const query = new URLSearchParams(url.includes('?') ? url.slice(url.indexOf('?') + 1) : '');

  try {
    // ---- updates ----------------------------------------------------------
    if (path === '/api/system/update-status') return json(getUpdateStatus());
    if (path === '/api/system/update-check') return json(await checkForUpdate());
    if (path === '/api/system/update' && method === 'POST') {
      const result = startUpdate();
      return result.ok
        ? json({ ok: true, status: getUpdateStatus() }, 202)
        : json({ error: result.error, status: getUpdateStatus() }, result.code);
    }
    if (path === '/api/system/update-apk' && method === 'POST') {
      await downloadApk();
      return json({ ok: true });
    }
    if (path === '/api/system/update-rollback-notice' && method === 'DELETE') {
      dismissRollbackNotice();
      return json({ ok: true });
    }

    // ---- backups ----------------------------------------------------------
    if (path === '/api/system/backups' && method === 'GET') {
      return json({
        backups: readBackupIndex(),
        cloudDir: null,
        lastDailyBackupDate: lastDailyBackupDate(),
      });
    }
    if (path === '/api/system/backups' && method === 'POST') {
      const entry = await createBackup('manual');
      return json({ ok: true, name: entry.name }, 201);
    }
    if (path === '/api/system/backups/complete' || path === '/api/system/backups/complete-to-cloud') {
      return exportAndShare();
    }
    if (path === '/api/system/backups/download') {
      // Individual daily backups live in private storage; re-export instead of
      // digging them out, so the file the user receives is always readable.
      return exportAndShare();
    }
    if (path === '/api/system/backups/sync' && method === 'POST') {
      return json(
        {
          error:
            'On this device, use “Download complete backup” and pick Google Drive in the share sheet.',
        },
        400,
      );
    }

    // ---- restore ----------------------------------------------------------
    if (path === '/api/system/restore/candidates') {
      return json({ cloudDir: null, items: [] });
    }
    if (path === '/api/system/restore/upload' && method === 'POST') {
      const body = init?.body;
      if (!(body instanceof FormData)) return json({ error: 'No backup file provided.' }, 400);
      const file = [...body.values()].find((value): value is File => value instanceof File);
      if (!file) return json({ error: 'No backup file provided.' }, 400);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const inspected = inspectBackup(bytes);
      if (!inspected.ok) return json({ error: inspected.error }, 400);
      const token = crypto.randomUUID();
      staged.clear();
      staged.set(token, bytes);
      return json({
        token,
        compatible: true,
        manifest: {
          app: 'bharti-enterprise',
          kind: 'complete-backup',
          appVersion: getUpdateStatus().current,
          createdAt: new Date(file.lastModified).toISOString(),
          migrations: [],
          counts: { users: 0, purchases: 0, jobCards: 0, uploads: 0 },
        },
      });
    }
    if (path === '/api/system/restore/commit' && method === 'POST') {
      const payload = JSON.parse(String(init?.body ?? '{}')) as { token?: string };
      const bytes = payload.token ? staged.get(payload.token) : undefined;
      if (!bytes) {
        return json({ error: 'That backup could not be found — please choose it again.' }, 404);
      }
      const { importDatabase } = await import('./bridge');
      await importDatabase(bytes);
      staged.clear();
      return json({
        ok: true,
        note: 'Data restored. Sign in with an account from the restored data.',
      });
    }

    // ---- demo mode --------------------------------------------------------
    if (path.startsWith('/api/system/demo')) {
      const { demoCommand } = await import('./bridge');
      if (path === '/api/system/demo' && method === 'GET') {
        const state = await demoCommand('status');
        return json({ active: state.active, demoExists: state.exists, demoDir: 'on this device' });
      }
      if (path === '/api/system/demo/enter') {
        await demoCommand('enter', query.get('fresh') === '1');
        return json({ ok: true, note: 'Demo mode active. Sign in with admin / Admin@123.' });
      }
      if (path === '/api/system/demo/exit') {
        await demoCommand('exit');
        return json({ ok: true, note: 'Back on real data. Sign in with your usual account.' });
      }
      if (path === '/api/system/demo/remove') {
        await demoCommand('remove');
        return json({ ok: true });
      }
    }
  } catch (err) {
    return json({ error: (err as Error).message }, 400);
  }

  return json({ error: 'Not found' }, 404);
}
