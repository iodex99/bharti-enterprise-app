import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/connection';
import { audit } from '../services/audit.service';
import { hashPassword, revokeAllSessions } from '../services/auth.service';
import { requireRole } from '../middleware/auth';
import { idParamGuard } from '../middleware/params';
import { validateBody } from '../middleware/validate';
import { ROLES } from '@shared';

const createSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(50)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Letters, numbers, dot, dash and underscore only'),
  displayName: z.string().min(1).max(100),
  role: z.enum(ROLES),
  password: z.string().min(8).max(200),
});

const updateSchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
  role: z.enum(ROLES).optional(),
});

const resetPasswordSchema = z.object({
  password: z.string().min(8).max(200),
});

type UserListRow = {
  id: number;
  username: string;
  display_name: string;
  role: string;
  is_active: number;
  must_change_password: number;
  created_at: string;
};

export function usersRoutes(): Router {
  const router = Router();
  router.param('id', idParamGuard);
  router.use(requireRole('admin'));

  router.get('/', (_req, res) => {
    const rows = getDb()
      .prepare(
        `SELECT id, username, display_name, role, is_active, must_change_password, created_at
         FROM users ORDER BY username`,
      )
      .all() as UserListRow[];
    res.json({
      users: rows.map((r) => ({
        id: r.id,
        username: r.username,
        displayName: r.display_name,
        role: r.role,
        isActive: !!r.is_active,
        mustChangePassword: !!r.must_change_password,
        createdAt: r.created_at,
      })),
    });
  });

  router.post('/', validateBody(createSchema), (req, res) => {
    const db = getDb();
    const body = req.body as z.infer<typeof createSchema>;
    const existing = db
      .prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE')
      .get(body.username);
    if (existing) {
      res.status(409).json({ error: 'Username already exists.' });
      return;
    }
    let id = 0;
    const tx = db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO users (username, password_hash, display_name, role, must_change_password, created_by)
           VALUES (?, ?, ?, ?, 1, ?)`,
        )
        .run(body.username, hashPassword(body.password), body.displayName, body.role, req.user!.id);
      id = Number(info.lastInsertRowid);
      audit(getDb(), {
        userId: req.user!.id,
        action: 'create',
        entityType: 'user',
        entityId: id,
        new: { username: body.username, displayName: body.displayName, role: body.role },
        ip: req.ip,
      });
    });
    tx();
    res.status(201).json({ id });
  });

  router.patch('/:id', validateBody(updateSchema), (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const body = req.body as z.infer<typeof updateSchema>;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as
      | { id: number; display_name: string; role: string }
      | undefined;
    if (!user) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }
    const tx = db.transaction(() => {
      db.prepare('UPDATE users SET display_name = ?, role = ? WHERE id = ?').run(
        body.displayName ?? user.display_name,
        body.role ?? user.role,
        id,
      );
      audit(db, {
        userId: req.user!.id,
        action: 'update',
        entityType: 'user',
        entityId: id,
        old: { displayName: user.display_name, role: user.role },
        new: {
          displayName: body.displayName ?? user.display_name,
          role: body.role ?? user.role,
        },
        ip: req.ip,
      });
    });
    tx();
    // Role changes take effect immediately on other devices.
    if (body.role && body.role !== user.role) revokeAllSessions(db, id);
    res.json({ ok: true });
  });

  router.post('/:id/deactivate', (req, res) => {
    toggleActive(req, res, 0);
  });
  router.post('/:id/reactivate', (req, res) => {
    toggleActive(req, res, 1);
  });

  function toggleActive(req: Request, res: Response, active: 0 | 1): void {
    const db = getDb();
    const id = Number(req.params.id);
    if (active === 0 && id === req.user!.id) {
      res.status(400).json({ error: 'You cannot deactivate your own account.' });
      return;
    }
    const user = db.prepare('SELECT id, is_active FROM users WHERE id = ?').get(id) as
      | { id: number; is_active: number }
      | undefined;
    if (!user) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }
    const tx = db.transaction(() => {
      db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(active, id);
      audit(db, {
        userId: req.user!.id,
        action: active ? 'reactivate' : 'deactivate',
        entityType: 'user',
        entityId: id,
        old: { isActive: !!user.is_active },
        new: { isActive: !!active },
        ip: req.ip,
      });
    });
    tx();
    if (!active) revokeAllSessions(db, id); // instant lock-out
    res.json({ ok: true });
  }

  router.post('/:id/reset-password', validateBody(resetPasswordSchema), (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const body = req.body as z.infer<typeof resetPasswordSchema>;
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
    if (!user) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }
    const tx = db.transaction(() => {
      db.prepare(
        'UPDATE users SET password_hash = ?, must_change_password = 1, failed_logins = 0, locked_until = NULL WHERE id = ?',
      ).run(hashPassword(body.password), id);
      audit(db, {
        userId: req.user!.id,
        action: 'reset_password',
        entityType: 'user',
        entityId: id,
        ip: req.ip,
      });
    });
    tx();
    revokeAllSessions(db, id);
    res.json({ ok: true });
  });

  return router;
}
