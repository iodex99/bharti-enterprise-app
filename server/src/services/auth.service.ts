import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import type { Db } from '../db/connection';
import { nowIso } from '../db/connection';
import { audit } from './audit.service';
import type { Role } from '@shared';

export type SessionUser = {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  mustChangePassword: boolean;
};

const SESSION_HOURS = 12;
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;
const BCRYPT_COST = 11;

export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, BCRYPT_COST);
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

type UserRow = {
  id: number;
  username: string;
  password_hash: string;
  display_name: string;
  role: Role;
  is_active: number;
  must_change_password: number;
  failed_logins: number;
  locked_until: string | null;
};

export type LoginResult =
  | { ok: true; token: string; user: SessionUser }
  | { ok: false; error: string; code: number };

export function login(db: Db, username: string, password: string, ip: string | null): LoginResult {
  const user = db
    .prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
    .get(username.trim()) as UserRow | undefined;

  // Constant-shape failure so usernames can't be probed.
  const fail = (): LoginResult => ({ ok: false, error: 'Invalid username or password.', code: 401 });

  if (!user || !user.is_active) {
    if (!user) bcrypt.compareSync(password, '$2a$11$abcdefghijklmnopqrstuvXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');
    return fail();
  }

  if (user.locked_until && user.locked_until > nowIso()) {
    return {
      ok: false,
      code: 423,
      error: 'Account locked after repeated failures. Try again in a few minutes.',
    };
  }

  if (!bcrypt.compareSync(password, user.password_hash)) {
    const failures = user.failed_logins + 1;
    const lock = failures >= MAX_FAILED_LOGINS;
    const lockedUntil = lock
      ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000).toISOString()
      : null;
    db.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?').run(
      lock ? 0 : failures,
      lockedUntil,
      user.id,
    );
    return fail();
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_HOURS * 3600 * 1000).toISOString();
  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(user.id);
    db.prepare(
      'INSERT INTO sessions (token_hash, user_id, expires_at, ip) VALUES (?, ?, ?, ?)',
    ).run(hashToken(token), user.id, expires, ip);
    audit(db, { userId: user.id, action: 'login', entityType: 'session', ip });
  });
  tx();

  return { ok: true, token, user: toSessionUser(user) };
}

function toSessionUser(u: UserRow): SessionUser {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    role: u.role,
    mustChangePassword: !!u.must_change_password,
  };
}

/** Validate a session token; slides expiry when it has been in use for >1h. */
export function resolveSession(db: Db, token: string): SessionUser | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT s.id AS session_id, s.expires_at, s.last_seen_at, u.*
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.revoked_at IS NULL`,
    )
    .get(hashToken(token)) as (UserRow & { session_id: number; expires_at: string; last_seen_at: string }) | undefined;
  if (!row) return null;
  const now = nowIso();
  if (row.expires_at <= now || !row.is_active) return null;

  if (Date.parse(now) - Date.parse(row.last_seen_at) > 3600 * 1000) {
    const newExpiry = new Date(Date.now() + SESSION_HOURS * 3600 * 1000).toISOString();
    db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?').run(
      now,
      newExpiry,
      row.session_id,
    );
  }
  return toSessionUser(row);
}

export function logout(db: Db, token: string, userId: number | null, ip: string | null): void {
  const tx = db.transaction(() => {
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ?').run(
      nowIso(),
      hashToken(token),
    );
    audit(db, { userId, action: 'logout', entityType: 'session', ip });
  });
  tx();
}

export function revokeAllSessions(db: Db, userId: number, exceptToken?: string): void {
  if (exceptToken) {
    db.prepare(
      'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND token_hash != ?',
    ).run(nowIso(), userId, hashToken(exceptToken));
  } else {
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(
      nowIso(),
      userId,
    );
  }
}

export type ChangePasswordResult = { ok: true } | { ok: false; error: string };

export function changePassword(
  db: Db,
  userId: number,
  currentPassword: string,
  newPassword: string,
  currentToken: string,
  ip: string | null,
): ChangePasswordResult {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;
  if (!user) return { ok: false, error: 'User not found.' };
  if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
    return { ok: false, error: 'Current password is incorrect.' };
  }
  const tx = db.transaction(() => {
    db.prepare(
      'UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?',
    ).run(hashPassword(newPassword), userId);
    audit(db, { userId, action: 'change_password', entityType: 'user', entityId: userId, ip });
  });
  tx();
  // Other devices must sign in again with the new password.
  revokeAllSessions(db, userId, currentToken);
  return { ok: true };
}

/** First-boot setup: create the initial admin if no users exist. Returns the password once. */
export function ensureInitialAdmin(db: Db): { created: boolean; password?: string } {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  if (count > 0) return { created: false };
  const password = crypto.randomBytes(4).toString('hex'); // 8 hex chars, changed on first login
  db.prepare(
    `INSERT INTO users (username, password_hash, display_name, role, must_change_password)
     VALUES ('admin', ?, 'Administrator', 'admin', 1)`,
  ).run(hashPassword(password));
  return { created: true, password };
}
