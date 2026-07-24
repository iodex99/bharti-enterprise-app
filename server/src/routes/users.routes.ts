import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/connection';
import { audit } from '../services/audit.service';
import { hashPassword, revokeAllSessions } from '../services/auth.service';
import { requireRole } from '../middleware/auth';
import { idParamGuard } from '../middleware/params';
import { validateBody } from '../middleware/validate';
import { ROLES } from '@shared';

const createSchema = z
  .object({
    username: z
      .string()
      .min(3)
      .max(50)
      .regex(/^[a-zA-Z0-9._-]+$/, 'Letters, numbers, dot, dash and underscore only'),
    displayName: z.string().min(1).max(100),
    role: z.enum(ROLES),
    /** operators belong to ONE office (ADR-028); admin/owner see all (null) */
    officeId: z.number().int().positive().nullish(),
    password: z.string().min(8).max(200),
  })
  .refine((u) => u.role !== 'operator' || u.officeId != null, {
    message: 'Pick the office this operator works in',
    path: ['officeId'],
  });

const updateSchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
  role: z.enum(ROLES).optional(),
  officeId: z.number().int().positive().nullish(),
});

const resetPasswordSchema = z.object({
  password: z.string().min(8).max(200),
});

type UserListRow = {
  id: number;
  username: string;
  display_name: string;
  role: string;
  office_id: number | null;
  office_name: string | null;
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
        `SELECT u.id, u.username, u.display_name, u.role, u.office_id, o.name AS office_name,
                u.is_active, u.must_change_password, u.created_at
         FROM users u LEFT JOIN offices o ON o.id = u.office_id ORDER BY u.username`,
      )
      .all() as UserListRow[];
    res.json({
      users: rows.map((r) => ({
        id: r.id,
        username: r.username,
        displayName: r.display_name,
        role: r.role,
        officeId: r.office_id,
        officeName: r.office_name,
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
          `INSERT INTO users (username, password_hash, display_name, role, office_id, must_change_password, created_by)
           VALUES (?, ?, ?, ?, ?, 1, ?)`,
        )
        .run(
          body.username,
          hashPassword(body.password),
          body.displayName,
          body.role,
          body.role === 'operator' ? body.officeId : null,
          req.user!.id,
        );
      id = Number(info.lastInsertRowid);
      audit(getDb(), {
        userId: req.user!.id,
        action: 'create',
        entityType: 'user',
        entityId: id,
        new: { username: body.username, displayName: body.displayName, role: body.role, officeId: body.officeId },
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
      | { id: number; display_name: string; role: string; office_id: number | null }
      | undefined;
    if (!user) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }
    const nextRole = body.role ?? user.role;
    const nextOffice =
      nextRole === 'operator'
        ? (body.officeId !== undefined ? body.officeId : user.office_id)
        : null;
    if (nextRole === 'operator' && nextOffice == null) {
      res.status(400).json({ error: 'Pick the office this operator works in.' });
      return;
    }
    const tx = db.transaction(() => {
      db.prepare('UPDATE users SET display_name = ?, role = ?, office_id = ? WHERE id = ?').run(
        body.displayName ?? user.display_name,
        nextRole,
        nextOffice,
        id,
      );
      audit(db, {
        userId: req.user!.id,
        action: 'update',
        entityType: 'user',
        entityId: id,
        old: { displayName: user.display_name, role: user.role, officeId: user.office_id },
        new: {
          displayName: body.displayName ?? user.display_name,
          role: nextRole,
          officeId: nextOffice,
        },
        ip: req.ip,
      });
    });
    tx();
    // Role or office changes take effect immediately on other devices.
    if ((body.role && body.role !== user.role) || nextOffice !== user.office_id) {
      revokeAllSessions(db, id);
    }
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
