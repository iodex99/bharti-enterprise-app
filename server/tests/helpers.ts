import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

export type TestContext = {
  app: Express;
  db: import('../src/db/connection').Db;
  dir: string;
  cleanup: () => void;
};

/**
 * Fresh app + temp SQLite per suite. Uses dynamic imports AFTER setting DATA_DIR so
 * config.ts (which reads env at import time) picks up the temp dir.
 */
export async function makeTestContext(): Promise<TestContext> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bharti-test-'));
  process.env.DATA_DIR = dir;
  process.env.NODE_ENV = 'test';
  // Suites hammer /login from one IP; keep the limiter out of the way unless a
  // suite explicitly tests it (see ratelimit.test.ts).
  process.env.LOGIN_MAX_PER_MINUTE ??= '100000';
  delete process.env.BHARTI_SUPERVISED;
  delete process.env.BHARTI_ROOT;
  vi.resetModules();

  const { createApp } = await import('../src/app');
  const { getDb, closeDb } = await import('../src/db/connection');
  const { migrate } = await import('../src/db/migrate');
  const { hashPassword } = await import('../src/services/auth.service');

  const db = getDb();
  migrate(db);

  const insertUser = db.prepare(
    `INSERT INTO users (username, password_hash, display_name, role, office_id, must_change_password)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  // operators are pinned to an office (ADR-028); office 1 exists from migration 004
  insertUser.run('admin', hashPassword('Admin@123'), 'Admin', 'admin', null, 0);
  insertUser.run('operator', hashPassword('Operator@123'), 'Operator', 'operator', 1, 0);
  insertUser.run('owner', hashPassword('Owner@123'), 'Owner', 'owner', null, 0);

  const app = createApp();
  return {
    app,
    db,
    dir,
    cleanup: () => {
      closeDb();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(`${dir}-demo`, { recursive: true, force: true }); // demo sibling, if a test made one
    },
  };
}

/** Log in and return the session cookie ("bharti_session=..."). */
export async function loginAs(app: Express, username: string, password: string): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ username, password });
  if (res.status !== 200) throw new Error(`login as ${username} failed: ${res.status} ${res.text}`);
  const setCookie = res.headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  const session = cookies.find((c: string) => c.startsWith('bharti_session='));
  if (!session) throw new Error('no session cookie in login response');
  return session.split(';')[0]!;
}

export const CREDS = {
  admin: ['admin', 'Admin@123'],
  operator: ['operator', 'Operator@123'],
  owner: ['owner', 'Owner@123'],
} as const;
