import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { CREDS, loginAs, makeTestContext, type TestContext } from '../helpers';

/**
 * Exhaustive RBAC matrix: every route group × {admin, operator, owner, anon}.
 * Expected values are STATUS CODES after the auth layer:
 *  - 401 blocked (anon), 403 blocked (role), otherwise the "allowed" status the
 *    endpoint returns for this synthetic request (2xx/4xx business codes are fine —
 *    anything not 401/403 proves the role gate let it through).
 */
let ctx: TestContext;
const cookies: Record<string, string> = {};

beforeAll(async () => {
  ctx = await makeTestContext();
  // Dedicated target for mutation rows (id 99) so admin's "pass" calls never
  // deactivate the operator/owner accounts other rows sign in with.
  ctx.db
    .prepare(
      `INSERT INTO users (id, username, password_hash, display_name, role, must_change_password)
       VALUES (99, 'victim', (SELECT password_hash FROM users WHERE username='admin'), 'Victim', 'operator', 0)`,
    )
    .run();
  for (const [role, [user, pass]] of Object.entries(CREDS)) {
    cookies[role] = await loginAs(ctx.app, user, pass);
  }
});
afterAll(() => ctx.cleanup());

type Expected = number | 'pass';
type MatrixRow = {
  method: 'get' | 'post' | 'patch';
  path: string;
  body?: unknown;
  admin: Expected;
  operator: Expected;
  owner: Expected;
  anon: Expected;
};

// 'pass' = role gate must NOT block (endpoint may still 4xx on business rules).
const MATRIX: MatrixRow[] = [
  { method: 'get', path: '/api/system/health', admin: 'pass', operator: 'pass', owner: 'pass', anon: 'pass' },
  { method: 'get', path: '/api/system/version', admin: 'pass', operator: 'pass', owner: 'pass', anon: 'pass' },
  { method: 'get', path: '/api/system/update-status', admin: 'pass', operator: 'pass', owner: 'pass', anon: 401 },
  { method: 'post', path: '/api/system/update', admin: 'pass', operator: 403, owner: 403, anon: 401 },
  { method: 'get', path: '/api/system/backups', admin: 'pass', operator: 403, owner: 403, anon: 401 },
  { method: 'post', path: '/api/system/backups', admin: 'pass', operator: 403, owner: 403, anon: 401 },
  { method: 'get', path: '/api/users', admin: 'pass', operator: 403, owner: 403, anon: 401 },
  {
    method: 'post',
    path: '/api/users',
    body: { username: 'zz1', displayName: 'Z', role: 'operator', password: 'Zz123456' },
    admin: 'pass',
    operator: 403,
    owner: 403,
    anon: 401,
  },
  { method: 'patch', path: '/api/users/1', body: { displayName: 'X' }, admin: 'pass', operator: 403, owner: 403, anon: 401 },
  { method: 'post', path: '/api/users/99/deactivate', admin: 'pass', operator: 403, owner: 403, anon: 401 },
  { method: 'post', path: '/api/users/99/reactivate', admin: 'pass', operator: 403, owner: 403, anon: 401 },
  {
    method: 'post',
    path: '/api/users/99/reset-password',
    body: { password: 'Tmp12345' },
    admin: 'pass',
    operator: 403,
    owner: 403,
    anon: 401,
  },
  { method: 'get', path: '/api/audit', admin: 'pass', operator: 403, owner: 403, anon: 401 },
  { method: 'get', path: '/api/auth/me', admin: 'pass', operator: 'pass', owner: 'pass', anon: 401 },
];

describe('RBAC matrix', () => {
  for (const row of MATRIX) {
    for (const principal of ['admin', 'operator', 'owner', 'anon'] as const) {
      const expected = row[principal];
      it(`${row.method.toUpperCase()} ${row.path} as ${principal} -> ${expected}`, async () => {
        let req = request(ctx.app)[row.method](row.path);
        if (principal !== 'anon') req = req.set('Cookie', cookies[principal]!);
        if (row.body) req = req.send(row.body);
        const res = await req;
        if (expected === 'pass') {
          expect([401, 403]).not.toContain(res.status);
        } else {
          expect(res.status).toBe(expected);
        }
      });
    }
  }
});
