import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/connection';
import { changePassword, login, logout } from '../services/auth.service';
import { requireAuth, SESSION_COOKIE } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { config } from '../config';

const loginSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(200),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z
    .string()
    .min(8, 'New password must be at least 8 characters')
    .max(200)
    .refine((p) => /[a-zA-Z]/.test(p) && /[0-9]/.test(p), {
      message: 'New password must contain letters and numbers',
    }),
});

// Simple in-memory rate limit for the login endpoint (default 10 attempts/min per IP;
// env-tunable so tests can raise or squeeze it).
const MAX_LOGINS_PER_MINUTE = Number(process.env.LOGIN_MAX_PER_MINUTE ?? 10);
const attempts = new Map<string, number[]>();
function loginRateLimited(ip: string): boolean {
  const now = Date.now();
  const windowStart = now - 60_000;
  const list = (attempts.get(ip) ?? []).filter((t) => t > windowStart);
  list.push(now);
  attempts.set(ip, list);
  if (attempts.size > 10_000) attempts.clear(); // memory guard
  return list.length > MAX_LOGINS_PER_MINUTE;
}

export function authRoutes(): Router {
  const router = Router();

  router.post('/login', validateBody(loginSchema), (req, res) => {
    const ip = req.ip ?? null;
    if (ip && loginRateLimited(ip)) {
      res.status(429).json({ error: 'Too many attempts. Wait a minute and try again.' });
      return;
    }
    const { username, password } = req.body as z.infer<typeof loginSchema>;
    const result = login(getDb(), username, password, ip);
    if (!result.ok) {
      res.status(result.code).json({ error: result.error });
      return;
    }
    res.cookie(SESSION_COOKIE, result.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProduction && req.secure,
      maxAge: 12 * 3600 * 1000,
      path: '/',
    });
    res.json({ user: result.user });
  });

  router.post('/logout', requireAuth, (req, res) => {
    logout(getDb(), req.sessionToken!, req.user!.id, req.ip ?? null);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  router.get('/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
  });

  router.post('/change-password', requireAuth, validateBody(changePasswordSchema), (req, res) => {
    const { currentPassword, newPassword } = req.body as z.infer<typeof changePasswordSchema>;
    const result = changePassword(
      getDb(),
      req.user!.id,
      currentPassword,
      newPassword,
      req.sessionToken!,
      req.ip ?? null,
    );
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
