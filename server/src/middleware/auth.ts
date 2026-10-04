import type { NextFunction, Request, Response } from 'express';
import { getDb } from '../db/connection';
import { resolveSession, type SessionUser } from '../services/auth.service';
import { recordUserActivity } from '../services/activity';
import type { Role } from '@shared';

export const SESSION_COOKIE = 'bharti_session';

declare module 'express-serve-static-core' {
  interface Request {
    user?: SessionUser;
    sessionToken?: string;
  }
}

/**
 * Requests the CLIENT fires on a timer, not because a person did anything. They must not
 * count as activity: automatic updates wait for the office to go quiet, and a dashboard
 * or stock screen left open on a desk would otherwise hold that off for ever.
 *
 * Deliberately server-side rather than a header the client sets — a browser tab still
 * running the PREVIOUS version's code must not be able to block the next update.
 */
const BACKGROUND_POLLS = new Set([
  '/api/system/health',
  '/api/system/version',
  '/api/system/update-status',
  '/api/system/update-check',
  '/api/dashboard',
  '/api/dashboard/alerts',
  '/api/stock/summary',
]);

function isBackgroundPoll(req: Request): boolean {
  return req.method === 'GET' && BACKGROUND_POLLS.has(req.path);
}

/** Attach req.user when a valid session cookie is present (does not reject). */
export function attachUser(req: Request, _res: Response, next: NextFunction): void {
  const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
  if (token) {
    const user = resolveSession(getDb(), token);
    if (user) {
      req.user = user;
      req.sessionToken = token;
      // Someone is actually working — hold off any automatic update.
      if (!isBackgroundPoll(req)) recordUserActivity();
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
    // Behind a reverse proxy (tailscale serve, Cloudflare Tunnel) the browser's host may
    // only survive in X-Forwarded-Host if the proxy rewrote Host. Accepting it does not
    // weaken the check: a cross-site page cannot set that header without a CORS
    // preflight, which this app never grants — and SameSite=Lax already withholds the
    // session cookie from cross-site POSTs.
    const forwarded = req.headers['x-forwarded-host'];
    const forwardedHost = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
    if (originHost !== req.headers.host && originHost !== forwardedHost) {
      res.status(403).json({ error: 'Cross-origin request rejected.' });
      return;
    }
  } catch {
    res.status(403).json({ error: 'Invalid Origin header.' });
    return;
  }
  next();
}
