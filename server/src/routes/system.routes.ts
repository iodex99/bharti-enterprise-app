import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { getDb } from '../db/connection';
import { audit } from '../services/audit.service';
import { checkForUpdate, getUpdateStatus, startUpdate } from '../services/update.service';
import { backupFilePath, listBackups, runBackup } from '../services/backup.service';
import { runReconciliation } from '../services/reconciliation.service';
import { EXIT_APPLY_UPDATE, gracefulExit } from '../lifecycle';
import { requireAuth, requireRole } from '../middleware/auth';
import { validateBody } from '../middleware/validate';

/** Only whitelisted settings are editable over the API. */
const EDITABLE_SETTINGS: Record<string, z.ZodType> = {
  delayed_job_days: z
    .string()
    .regex(/^\d{1,3}$/, 'Enter a number of days (1–999)')
    .refine((v) => Number(v) > 0, 'Must be at least 1 day'),
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
    res.json({ backups: listBackups() });
  });

  router.post('/backups', requireRole('admin'), async (_req, res) => {
    const name = await runBackup('manual');
    res.status(201).json({ ok: true, name });
  });

  router.get('/reconciliation', requireRole('admin'), (_req, res) => {
    res.json(runReconciliation(getDb()));
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

  return router;
}
