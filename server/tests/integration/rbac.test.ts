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
  method: 'get' | 'post' | 'patch' | 'put' | 'delete';
  path: string;
  body?: unknown;
  admin: Expected;
  operator: Expected;
  owner: Expected;
  anon: Expected;
};

// 'pass' = role gate must NOT block (endpoint may still 4xx on business rules).
const MATRIX: MatrixRow[] = [
  {
    method: 'get',
    path: '/api/system/health',
    admin: 'pass',
    operator: 'pass',
    owner: 'pass',
    anon: 'pass',
  },
  {
    method: 'get',
    path: '/api/system/version',
    admin: 'pass',
    operator: 'pass',
    owner: 'pass',
    anon: 'pass',
  },
  {
    method: 'get',
    path: '/api/system/update-status',
    admin: 'pass',
    operator: 'pass',
    owner: 'pass',
    anon: 401,
  },
  {
    method: 'post',
    path: '/api/system/update',
    admin: 'pass',
    operator: 403,
    owner: 403,
    anon: 401,
  },
  {
    method: 'get',
    path: '/api/system/backups',
    admin: 'pass',
    operator: 403,
    owner: 403,
    anon: 401,
  },
  {
    method: 'post',
    path: '/api/system/backups',
    admin: 'pass',
    operator: 403,
    owner: 403,
    anon: 401,
  },
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
  {
    method: 'patch',
    path: '/api/users/1',
    body: { displayName: 'X' },
    admin: 'pass',
    operator: 403,
    owner: 403,
    anon: 401,
  },
  {
    method: 'post',
    path: '/api/users/99/deactivate',
    admin: 'pass',
    operator: 403,
    owner: 403,
    anon: 401,
  },
  {
    method: 'post',
    path: '/api/users/99/reactivate',
    admin: 'pass',
    operator: 403,
    owner: 403,
    anon: 401,
  },
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
  {
    method: 'get',
    path: '/api/auth/me',
    admin: 'pass',
    operator: 'pass',
    owner: 'pass',
    anon: 401,
  },
  {
    method: 'get',
    path: '/api/system/setup-state',
    admin: 'pass',
    operator: 'pass',
    owner: 'pass',
    anon: 401,
  },
  {
    method: 'post',
    path: '/api/system/setup/complete',
    admin: 'pass',
    operator: 403,
    owner: 403,
    anon: 401,
  },
  {
    method: 'get',
    path: '/api/system/backups/complete',
    admin: 'pass',
    operator: 403,
    owner: 403,
    anon: 401,
  },
  {
    method: 'post',
    path: '/api/system/backups/complete-to-cloud',
    admin: 'pass',
    operator: 403,
    owner: 403,
    anon: 401,
  },
  {
    method: 'get',
    path: '/api/system/restore/candidates',
    admin: 'pass',
    operator: 403,
    owner: 403,
    anon: 401,
  },
  {
    method: 'post',
    path: '/api/system/restore/upload',
    admin: 'pass',
    operator: 403,
    owner: 403,
    anon: 401,
  },
  {
    method: 'post',
    path: '/api/system/restore/commit',
    body: { token: 'deadbeef' },
    admin: 'pass',
    operator: 403,
    owner: 403,
    anon: 401,
  },
  {
    method: 'get',
    path: '/api/discrepancies',
    admin: 'pass',
    operator: 'pass',
    owner: 'pass',
    anon: 401,
  },
  {
    method: 'post',
    path: '/api/discrepancies/1/resolve',
    body: { note: 'rbac probe' },
    admin: 'pass',
    operator: 403,
    owner: 403,
    anon: 401,
  },

  // ---- system & offices ----------------------------------------------------
  {
    method: 'get',
    path: '/api/system/reconciliation',
    admin: 'pass',
    operator: 403,
    owner: 403,
    anon: 401,
  },
  {
    method: 'get',
    path: '/api/system/settings',
    admin: 'pass',
    operator: 403,
    owner: 403,
    anon: 401,
  },
  {
    method: 'put',
    path: '/api/system/settings',
    body: { key: 'delayed_job_days', value: '7' },
    admin: 'pass',
    operator: 403,
    owner: 403,
    anon: 401,
  },
  { method: 'get', path: '/api/system/demo', admin: 'pass', operator: 403, owner: 403, anon: 401 },
  {
    method: 'get',
    path: '/api/offices',
    admin: 'pass',
    operator: 'pass',
    owner: 'pass',
    anon: 401,
  },
  {
    method: 'post',
    path: '/api/offices',
    body: { code: 'ZZ', name: 'Probe' },
    admin: 'pass',
    operator: 403,
    owner: 403,
    anon: 401,
  },
  {
    method: 'put',
    path: '/api/offices/1',
    body: { code: 'HO', name: 'Main Office', isActive: true },
    admin: 'pass',
    operator: 403,
    owner: 403,
    anon: 401,
  },
  {
    method: 'get',
    path: '/api/products',
    admin: 'pass',
    operator: 'pass',
    owner: 'pass',
    anon: 401,
  },

  // ---- masters: reads for everyone, writes admin-only -----------------------
  {
    method: 'get',
    path: '/api/masters/colors',
    admin: 'pass',
    operator: 'pass',
    owner: 'pass',
    anon: 401,
  },
  {
    method: 'get',
    path: '/api/masters/staff',
    admin: 'pass',
    operator: 'pass',
    owner: 'pass',
    anon: 401,
  },
  {
    method: 'post',
    path: '/api/masters/colors',
    body: { name: 'RBAC Probe' },
    admin: 'pass',
    operator: 403,
    owner: 403,
    anon: 401,
  },
  {
    method: 'put',
    path: '/api/masters/colors/1',
    body: { name: 'RBAC Probe 2' },
    admin: 'pass',
    operator: 403,
    owner: 403,
    anon: 401,
  },
  {
    method: 'post',
    path: '/api/masters/colors/1/deactivate',
    admin: 'pass',
    operator: 403,
    owner: 403,
    anon: 401,
  },
  {
    method: 'post',
    path: '/api/masters/colors/1/reactivate',
    admin: 'pass',
    operator: 403,
    owner: 403,
    anon: 401,
  },
  {
    method: 'delete',
    path: '/api/masters/colors/999',
    admin: 'pass',
    operator: 403,
    owner: 403,
    anon: 401,
  },
  { method: 'post', path: '/api/uploads', admin: 'pass', operator: 'pass', owner: 403, anon: 401 },

  // ---- purchases: operators enter, only admin voids ------------------------
  {
    method: 'get',
    path: '/api/purchases',
    admin: 'pass',
    operator: 'pass',
    owner: 'pass',
    anon: 401,
  },
  {
    method: 'post',
    path: '/api/purchases',
    body: {},
    admin: 'pass',
    operator: 'pass',
    owner: 403,
    anon: 401,
  },
  {
    method: 'put',
    path: '/api/purchases/1',
    body: { ratePaisePerYard: 100, notes: '' },
    admin: 'pass',
    operator: 'pass',
    owner: 403,
    anon: 401,
  },
  {
    method: 'post',
    path: '/api/purchases/1/void',
    body: { reason: 'rbac probe' },
    admin: 'pass',
    operator: 403,
    owner: 403,
    anon: 401,
  },

  // ---- opening balances are admin-only end to end --------------------------
  {
    method: 'get',
    path: '/api/opening-balances',
    admin: 'pass',
    operator: 403,
    owner: 403,
    anon: 401,
  },
  {
    method: 'post',
    path: '/api/opening-balances',
    body: {},
    admin: 'pass',
    operator: 403,
    owner: 403,
    anon: 401,
  },
  {
    method: 'post',
    path: '/api/opening-balances/1/void',
    body: { reason: 'rbac probe' },
    admin: 'pass',
    operator: 403,
    owner: 403,
    anon: 401,
  },

  // ---- cutting: operators may correct their own un-consumed entries --------
  {
    method: 'get',
    path: '/api/cutting',
    admin: 'pass',
    operator: 'pass',
    owner: 'pass',
    anon: 401,
  },
  {
    method: 'post',
    path: '/api/cutting',
    body: {},
    admin: 'pass',
    operator: 'pass',
    owner: 403,
    anon: 401,
  },
  {
    method: 'put',
    path: '/api/cutting/1',
    body: {},
    admin: 'pass',
    operator: 'pass',
    owner: 403,
    anon: 401,
  },
  {
    method: 'delete',
    path: '/api/cutting/1',
    admin: 'pass',
    operator: 'pass',
    owner: 403,
    anon: 401,
  },
  {
    method: 'post',
    path: '/api/cutting/1/void',
    body: { reason: 'rbac probe' },
    admin: 'pass',
    operator: 403,
    owner: 403,
    anon: 401,
  },

  // ---- job work: closing with a discrepancy is a supervisory act ----------
  { method: 'get', path: '/api/jobs', admin: 'pass', operator: 'pass', owner: 'pass', anon: 401 },
  {
    method: 'get',
    path: '/api/jobs/1/receipts',
    admin: 'pass',
    operator: 'pass',
    owner: 'pass',
    anon: 401,
  },
  {
    method: 'post',
    path: '/api/jobs',
    body: {},
    admin: 'pass',
    operator: 'pass',
    owner: 403,
    anon: 401,
  },
  {
    method: 'put',
    path: '/api/jobs/1',
    body: {},
    admin: 'pass',
    operator: 'pass',
    owner: 403,
    anon: 401,
  },
  { method: 'delete', path: '/api/jobs/1', admin: 'pass', operator: 'pass', owner: 403, anon: 401 },
  {
    method: 'post',
    path: '/api/jobs/1/receipts',
    body: {},
    admin: 'pass',
    operator: 'pass',
    owner: 403,
    anon: 401,
  },
  {
    method: 'post',
    path: '/api/jobs/1/close',
    body: { reason: 'wastage', note: 'rbac probe' },
    admin: 'pass',
    operator: 403,
    owner: 403,
    anon: 401,
  },
  {
    method: 'post',
    path: '/api/jobs/1/void',
    body: { reason: 'rbac probe' },
    admin: 'pass',
    operator: 403,
    owner: 403,
    anon: 401,
  },

  // ---- money: operators record payments, only admin voids them ------------
  {
    method: 'get',
    path: '/api/contractors/analytics',
    admin: 'pass',
    operator: 'pass',
    owner: 'pass',
    anon: 401,
  },
  {
    method: 'get',
    path: '/api/contractors/dues',
    admin: 'pass',
    operator: 'pass',
    owner: 'pass',
    anon: 401,
  },
  {
    method: 'get',
    path: '/api/contractors/payments',
    admin: 'pass',
    operator: 'pass',
    owner: 'pass',
    anon: 401,
  },
  {
    method: 'post',
    path: '/api/contractors/payments',
    body: {},
    admin: 'pass',
    operator: 'pass',
    owner: 403,
    anon: 401,
  },
  {
    method: 'post',
    path: '/api/contractors/payments/1/void',
    body: { reason: 'rbac probe' },
    admin: 'pass',
    operator: 403,
    owner: 403,
    anon: 401,
  },
  {
    method: 'get',
    path: '/api/staff/analytics',
    admin: 'pass',
    operator: 'pass',
    owner: 'pass',
    anon: 401,
  },
  {
    method: 'get',
    path: '/api/staff/dues',
    admin: 'pass',
    operator: 'pass',
    owner: 'pass',
    anon: 401,
  },
  {
    method: 'get',
    path: '/api/staff/payments',
    admin: 'pass',
    operator: 'pass',
    owner: 'pass',
    anon: 401,
  },
  {
    method: 'post',
    path: '/api/staff/payments',
    body: {},
    admin: 'pass',
    operator: 'pass',
    owner: 403,
    anon: 401,
  },
  {
    method: 'post',
    path: '/api/staff/payments/1/void',
    body: { reason: 'rbac probe' },
    admin: 'pass',
    operator: 403,
    owner: 403,
    anon: 401,
  },

  // ---- checking, packing, dispatch ----------------------------------------
  {
    method: 'get',
    path: '/api/checking',
    admin: 'pass',
    operator: 'pass',
    owner: 'pass',
    anon: 401,
  },
  {
    method: 'get',
    path: '/api/checking/pending',
    admin: 'pass',
    operator: 'pass',
    owner: 'pass',
    anon: 401,
  },
  {
    method: 'post',
    path: '/api/checking',
    body: {},
    admin: 'pass',
    operator: 'pass',
    owner: 403,
    anon: 401,
  },
  {
    method: 'post',
    path: '/api/checking/1/results',
    body: {},
    admin: 'pass',
    operator: 'pass',
    owner: 403,
    anon: 401,
  },
  {
    method: 'post',
    path: '/api/checking/1/pack',
    body: {},
    admin: 'pass',
    operator: 'pass',
    owner: 403,
    anon: 401,
  },
  {
    method: 'post',
    path: '/api/checking/1/void',
    body: { reason: 'rbac probe' },
    admin: 'pass',
    operator: 403,
    owner: 403,
    anon: 401,
  },
  {
    method: 'get',
    path: '/api/packing',
    admin: 'pass',
    operator: 'pass',
    owner: 'pass',
    anon: 401,
  },
  {
    method: 'post',
    path: '/api/packing',
    body: {},
    admin: 'pass',
    operator: 'pass',
    owner: 403,
    anon: 401,
  },
  {
    method: 'post',
    path: '/api/packing/1/results',
    body: {},
    admin: 'pass',
    operator: 'pass',
    owner: 403,
    anon: 401,
  },
  {
    method: 'post',
    path: '/api/packing/1/void',
    body: { reason: 'rbac probe' },
    admin: 'pass',
    operator: 403,
    owner: 403,
    anon: 401,
  },
  {
    method: 'get',
    path: '/api/dispatches',
    admin: 'pass',
    operator: 'pass',
    owner: 'pass',
    anon: 401,
  },
  {
    method: 'post',
    path: '/api/dispatches',
    body: {},
    admin: 'pass',
    operator: 403,
    owner: 403,
    anon: 401,
  },
  {
    method: 'post',
    path: '/api/dispatches/1/void',
    body: { reason: 'rbac probe' },
    admin: 'pass',
    operator: 403,
    owner: 403,
    anon: 401,
  },

  // ---- read models: every signed-in role, nobody anonymous -----------------
  {
    method: 'get',
    path: '/api/stock/summary',
    admin: 'pass',
    operator: 'pass',
    owner: 'pass',
    anon: 401,
  },
  {
    method: 'get',
    path: '/api/stock/raw',
    admin: 'pass',
    operator: 'pass',
    owner: 'pass',
    anon: 401,
  },
  {
    method: 'get',
    path: '/api/stock/FG',
    admin: 'pass',
    operator: 'pass',
    owner: 'pass',
    anon: 401,
  },
  {
    method: 'get',
    path: '/api/reports',
    admin: 'pass',
    operator: 'pass',
    owner: 'pass',
    anon: 401,
  },
  {
    method: 'get',
    path: '/api/reports/fg-stock',
    admin: 'pass',
    operator: 'pass',
    owner: 'pass',
    anon: 401,
  },
  {
    method: 'get',
    path: '/api/reports/full',
    admin: 'pass',
    operator: 'pass',
    owner: 'pass',
    anon: 401,
  },
  {
    method: 'get',
    path: '/api/trace/fg-lots',
    admin: 'pass',
    operator: 'pass',
    owner: 'pass',
    anon: 401,
  },
  {
    method: 'get',
    path: '/api/trace/fg/1',
    admin: 'pass',
    operator: 'pass',
    owner: 'pass',
    anon: 401,
  },
  {
    method: 'get',
    path: '/api/trace/purchase/1',
    admin: 'pass',
    operator: 'pass',
    owner: 'pass',
    anon: 401,
  },
  {
    method: 'get',
    path: '/api/dashboard',
    admin: 'pass',
    operator: 'pass',
    owner: 'pass',
    anon: 401,
  },
  {
    method: 'get',
    path: '/api/dashboard/alerts',
    admin: 'pass',
    operator: 'pass',
    owner: 'pass',
    anon: 401,
  },
  {
    method: 'get',
    path: '/uploads/2026-01/nope.webp',
    admin: 'pass',
    operator: 'pass',
    owner: 'pass',
    anon: 401,
  },
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
