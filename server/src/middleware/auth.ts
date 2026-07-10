import type { NextFunction, Request, Response } from 'express';
import { getDb } from '../db/connection';
import { resolveSession, type SessionUser } from '../services/auth.service';
import type { Role } from '@shared';

export const SESSION_COOKIE = 'bharti_session';

declare module 'express-serve-static-core' {
  interface Request {
    user?: SessionUser;
    sessionToken?: string;
  }
}

/** Attach req.user when a valid session cookie is present (does not reject). */
export function attachUser(req: Request, _res: Response, next: NextFunction): void {
  const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
  if (token) {
    const user = resolveSession(getDb(), token);
    if (user) {
      req.user = user;
      req.sessionToken = token;
    }
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Sign in required.' });
    return;
  }
  next();
}

/** Role gate. Usage: router.post('/', requireRole('admin', 'operator'), handler) */
export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Sign in required.' });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: 'You do not have permission for this action.' });
      return;
    }
    next();
  };
}

/**
 * CSRF belt-and-braces: mutating requests must not come from a foreign origin.
 * SameSite=Lax already blocks cross-site cookie sends; this guards legacy edge cases.
 */
export function checkOrigin(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    next();
    return;
  }
  const origin = req.headers.origin;
  if (!origin) {
    next(); // non-browser clients (tests, curl) send no Origin
    return;
  }
  try {
    const originHost = new URL(origin).host;
    if (originHost !== req.headers.host) {
      res.status(403).json({ error: 'Cross-origin request rejected.' });
      return;
    }
  } catch {
    res.status(403).json({ error: 'Invalid Origin header.' });
    return;
  }
  next();
}
