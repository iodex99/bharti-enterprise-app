import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { getDb } from '../db/connection';
import { isDemoMode } from '../db/dataDirs';
import { audit } from '../services/audit.service';
import { markSetupComplete, setupState } from '../services/setup.service';
import { runReconciliation } from '../services/reconciliation.service';
import { requireAuth, requireRole } from '../middleware/auth';
import { validateBody } from '../middleware/validate';

/**
 * Runtime-neutral /api/system endpoints — everything that is pure database work.
 * Host-specific operations (self-update, disk backups, restore, demo mode) come in
 * as a sub-router so the Android bundle never pulls Node-only code; on Android those
 * paths are served by the native bridge instead (client/src/local/bridge.ts).
 */

const startedAt = Date.now();

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

export function systemRoutes(ops?: Router): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      version: config.version,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      demoMode: isDemoMode(),
    });
  });

  router.get('/version', (_req, res) => {
    res.json({ version: config.version });
  });

  router.get('/reconciliation', requireRole('admin'), (_req, res) => {
    res.json(runReconciliation(getDb()));
  });

  router.get('/settings', requireRole('admin'), (_req, res) => {
    const keys = Object.keys(EDITABLE_SETTINGS);
    const rows = getDb()
      .prepare(`SELECT key, value FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`)
      .all(...keys) as Array<{ key: string; value: string }>;
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

  // ---- first-run setup wizard ---------------------------------------------
  router.get('/setup-state', requireAuth, (_req, res) => {
    res.json(setupState(getDb()));
  });

  router.post('/setup/complete', requireRole('admin'), (req, res) => {
    markSetupComplete(getDb(), req.user!.id, req.ip ?? null);
    res.json({ ok: true });
  });

  if (ops) router.use('/', ops);

  return router;
}
