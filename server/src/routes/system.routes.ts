import { Router } from 'express';
import { config } from '../config';
import { checkForUpdate, getUpdateStatus, startUpdate } from '../services/update.service';
import { backupFilePath, listBackups, runBackup } from '../services/backup.service';
import { EXIT_APPLY_UPDATE, gracefulExit } from '../lifecycle';
import { requireAuth, requireRole } from '../middleware/auth';

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
