import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../config';
import { getDb } from '../db/connection';
import { REAL_DATA_DIR } from '../db/dataDirs';
import { audit } from '../services/audit.service';
import { checkForUpdate, getUpdateStatus, startUpdate } from '../services/update.service';
import {
  backupFilePath,
  cloudBackupDir,
  lastDailyBackupDate,
  listBackups,
  mirrorToCloud,
  runBackup,
} from '../services/backup.service';
import {
  buildSnapshotBuffer,
  cleanupStaging,
  cloudSnapshotPath,
  inspectSnapshot,
  listCloudSnapshots,
  newUploadToken,
  restoreSnapshot,
  sendCompleteSnapshotToCloud,
  stagedUploadPath,
} from '../services/snapshot.service';
import { markSetupComplete, setupState } from '../services/setup.service';
import { runReconciliation } from '../services/reconciliation.service';
import { demoStatus, enterDemoMode, exitDemoMode, removeDemoData } from '../services/demo.service';
import { isDemoMode } from '../db/dataDirs';
import { EXIT_APPLY_UPDATE, gracefulExit } from '../lifecycle';
import { requireAuth, requireRole } from '../middleware/auth';
import { validateBody } from '../middleware/validate';

const MAX_RESTORE_BYTES = 1024 * 1024 * 1024; // 1 GB — years of photos + the database

/** Uploaded restore files land in the staging dir under a hex token filename. */
const restoreUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const dir = path.join(REAL_DATA_DIR, 'restore-staging');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, _file, cb) => cb(null, `${newUploadToken()}.zip`),
  }),
  limits: { fileSize: MAX_RESTORE_BYTES, files: 1 },
  // Light pre-filter only — the real gate is inspectSnapshot (checks the manifest + magic),
  // so accept zip-ish types and a renamed/extension-less download rather than false-reject.
  fileFilter: (_req, file, cb) => {
    const zipish = ['application/zip', 'application/x-zip-compressed', 'application/octet-stream', ''];
    cb(null, file.originalname.toLowerCase().endsWith('.zip') || zipish.includes(file.mimetype));
  },
});

/** Only whitelisted settings are editable over the API. */
const EDITABLE_SETTINGS: Record<string, z.ZodType> = {
  delayed_job_days: z
    .string()
    .regex(/^\d{1,3}$/, 'Enter a number of days (1–999)')
    .refine((v) => Number(v) > 0, 'Must be at least 1 day'),
  // path of a folder synced by Google Drive for Desktop / OneDrive; '' turns it off
  cloud_backup_dir: z.string().trim().max(300),
};

const settingSchema = z.object({
  key: z.string().refine((k) => k in EDITABLE_SETTINGS, 'Unknown setting'),
  value: z.string().max(100),
});

export function systemRoutes(): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      version: config.version,
      uptimeSeconds: Math.round(process.uptime()),
      demoMode: isDemoMode(),
    });
  });

  router.get('/version', (_req, res) => {
    res.json({ version: config.version });
  });

  // Any signed-in user sees the banner state; only Admin can act on it.
  router.get('/update-status', requireAuth, (_req, res) => {
    res.json(getUpdateStatus());
  });

  router.get('/update-check', requireAuth, async (_req, res) => {
    res.json(await checkForUpdate());
  });

  router.post('/update', requireRole('admin'), (_req, res) => {
    const result = startUpdate(() => {
      // Give the HTTP response time to flush before draining.
      setTimeout(() => gracefulExit(EXIT_APPLY_UPDATE), 300);
    });
    if (!result.ok) {
      res.status(result.code).json({ error: result.error, status: getUpdateStatus() });
      return;
    }
    res.status(202).json({ ok: true, status: getUpdateStatus() });
  });

  router.get('/backups', requireRole('admin'), (_req, res) => {
    res.json({
      backups: listBackups(),
      cloudDir: cloudBackupDir(getDb()),
      lastDailyBackupDate: lastDailyBackupDate(getDb()),
    });
  });

  router.post('/backups', requireRole('admin'), async (_req, res) => {
    const name = await runBackup('manual');
    res.status(201).json({ ok: true, name });
  });

  /** Copy all backups into the configured cloud-synced folder right now. */
  router.post('/backups/sync', requireRole('admin'), (_req, res) => {
    const result = mirrorToCloud(getDb());
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json(result);
  });

  router.get('/reconciliation', requireRole('admin'), (_req, res) => {
    res.json(runReconciliation(getDb()));
  });

  // ---- demo mode (admin): a physically separate database, switchable live ----
  router.get('/demo', requireRole('admin'), (_req, res) => {
    res.json(demoStatus());
  });

  router.post('/demo/enter', requireRole('admin'), (req, res) => {
    const fresh = req.query.fresh === '1';
    const result = enterDemoMode(fresh, req.user!.id, req.ip ?? null);
    if (!result.ok) {
      res.status(result.code).json({ error: result.error });
      return;
    }
    // the session lives in the REAL database — the client must sign in again
    res.json({ ok: true, note: 'Demo mode active. Sign in with admin / Admin@123.' });
  });

  router.post('/demo/exit', requireRole('admin'), (_req, res) => {
    const result = exitDemoMode();
    if (!result.ok) {
      res.status(result.code).json({ error: result.error });
      return;
    }
    res.json({ ok: true, note: 'Back on real data. Sign in with your usual account.' });
  });

  router.post('/demo/remove', requireRole('admin'), (req, res) => {
    const result = removeDemoData(req.user!.id, req.ip ?? null);
    if (!result.ok) {
      res.status(result.code).json({ error: result.error });
      return;
    }
    res.json({ ok: true });
  });

  router.get('/settings', requireRole('admin'), (_req, res) => {
    const rows = getDb()
      .prepare(`SELECT key, value FROM settings WHERE key IN (${Object.keys(EDITABLE_SETTINGS).map(() => '?').join(',')})`)
      .all(...Object.keys(EDITABLE_SETTINGS)) as Array<{ key: string; value: string }>;
    const settings: Record<string, string> = { delayed_job_days: '7' };
    for (const row of rows) settings[row.key] = row.value;
    res.json({ settings });
  });

  router.put('/settings', requireRole('admin'), validateBody(settingSchema), (req, res) => {
    const { key, value } = req.body as { key: string; value: string };
    const valueCheck = EDITABLE_SETTINGS[key]!.safeParse(value);
    if (!valueCheck.success) {
      res.status(400).json({ error: valueCheck.error.issues[0]?.message ?? 'Invalid value' });
      return;
    }
    const db = getDb();
    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO settings (key, value, updated_by) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_by = excluded.updated_by`,
      ).run(key, value, req.user!.id);
      audit(db, {
        userId: req.user!.id,
        action: 'update',
        entityType: 'setting',
        new: { key, value },
        ip: req.ip,
      });
    });
    tx();
    res.json({ ok: true });
  });

  router.get('/backups/download', requireRole('admin'), (req, res) => {
    const name = typeof req.query.name === 'string' ? req.query.name : '';
    const file = backupFilePath(name);
    if (!file) {
      res.status(404).json({ error: 'Backup not found.' });
      return;
    }
    res.download(file, name.replace(/[/\\]/g, '_'));
  });

  // ---- complete backup + migration (admin) --------------------------------
  // A "complete backup" is one .zip with the database AND every uploaded photo —
  // the unit you move to a new PC. Refused in demo mode (it must act on real data).
  const denyInDemo = (res: import('express').Response): boolean => {
    if (isDemoMode()) {
      res.status(409).json({ error: 'Exit demo mode first — complete backups act on real data.' });
      return true;
    }
    return false;
  };

  /** One click → download the whole business as a single file (built in memory, no temp). */
  router.get('/backups/complete', requireRole('admin'), (_req, res) => {
    if (denyInDemo(res)) return;
    const date = new Date().toISOString().slice(0, 10);
    let out: { buffer: Buffer };
    try {
      out = buildSnapshotBuffer();
    } catch (err) {
      console.error('[backup] complete snapshot failed:', err);
      res.status(500).json({ error: 'Could not build the complete backup.' });
      return;
    }
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="bharti-complete-backup-${date}.zip"`);
    res.send(out.buffer);
  });

  /** Build a complete backup straight into the Google-Drive-synced folder. */
  router.post('/backups/complete-to-cloud', requireRole('admin'), (_req, res) => {
    if (denyInDemo(res)) return;
    const result = sendCompleteSnapshotToCloud(getDb());
    res.status(result.ok ? 200 : result.code).json(result.ok ? { ok: true, name: result.name } : { error: result.error });
  });

  /** Complete backups sitting in the cloud folder — the pick-list when restoring on a new PC. */
  router.get('/restore/candidates', requireRole('admin'), (_req, res) => {
    if (denyInDemo(res)) return;
    res.json(listCloudSnapshots(getDb()));
  });

  /** Step 1: upload a complete-backup file; we park it and report what's inside. */
  router.post('/restore/upload', requireRole('admin'), (req, res) => {
    if (denyInDemo(res)) return;
    cleanupStaging();
    restoreUpload.single('backup')(req, res, (err: unknown) => {
      if (err) {
        const msg = (err as { code?: string }).code === 'LIMIT_FILE_SIZE' ? 'That file is too large.' : 'Upload failed.';
        res.status(400).json({ error: msg });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: 'No backup file provided (field name: backup).' });
        return;
      }
      const token = path.basename(req.file.filename, '.zip');
      const inspected = inspectSnapshot(req.file.path);
      if (!inspected.ok) {
        fs.rmSync(req.file.path, { force: true });
        res.status(400).json({ error: inspected.error });
        return;
      }
      res.json({ token, manifest: inspected.manifest, compatible: inspected.compatible, warning: inspected.warning });
    });
  });

  /** Step 2: commit a restore, from an uploaded token OR a cloud-folder file. Replaces ALL data. */
  const commitSchema = z
    .object({ token: z.string().optional(), cloudName: z.string().optional() })
    .refine((b) => !!b.token || !!b.cloudName, 'Provide a token or a cloud file name.');
  router.post('/restore/commit', requireRole('admin'), validateBody(commitSchema), (req, res) => {
    if (denyInDemo(res)) return;
    const { token, cloudName } = req.body as { token?: string; cloudName?: string };
    const zipPath = token ? stagedUploadPath(token) : cloudSnapshotPath(getDb(), cloudName!);
    if (!zipPath || !fs.existsSync(zipPath)) {
      res.status(404).json({ error: 'That backup could not be found — please upload it again.' });
      return;
    }
    const result = restoreSnapshot(zipPath, req.user?.id ?? null, req.ip ?? null);
    if (token) fs.rmSync(zipPath, { force: true });
    if (!result.ok) {
      res.status(result.code).json({ error: result.error });
      return;
    }
    // sessions live in the (now replaced) database — the client must sign in again
    res.json({ ok: true, manifest: result.manifest, note: 'Data restored. Sign in with an account from the restored data.' });
  });

  // ---- first-run setup wizard ---------------------------------------------
  router.get('/setup-state', requireAuth, (_req, res) => {
    res.json(setupState(getDb()));
  });

  router.post('/setup/complete', requireRole('admin'), (req, res) => {
    markSetupComplete(getDb(), req.user!.id, req.ip ?? null);
    res.json({ ok: true });
  });

  return router;
}
