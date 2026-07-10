import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { loginAs, makeTestContext, type TestContext } from '../helpers';

let ctx: TestContext;
let adminCookie: string;

beforeAll(async () => {
  ctx = await makeTestContext();
  adminCookie = await loginAs(ctx.app, 'admin', 'Admin@123');
});
afterAll(() => ctx.cleanup());

describe('user management', () => {
  it('creates a user who must change password at first login', async () => {
    const create = await request(ctx.app)
      .post('/api/users')
      .set('Cookie', adminCookie)
      .send({ username: 'sunita', displayName: 'Sunita', role: 'operator', password: 'Temp1234' });
    expect(create.status).toBe(201);

    // duplicate rejected (case-insensitive)
    const dup = await request(ctx.app)
      .post('/api/users')
      .set('Cookie', adminCookie)
      .send({ username: 'SUNITA', displayName: 'S2', role: 'operator', password: 'Temp1234' });
    expect(dup.status).toBe(409);

    const cookie = await loginAs(ctx.app, 'sunita', 'Temp1234');
    const me = await request(ctx.app).get('/api/auth/me').set('Cookie', cookie);
    expect(me.body.user.mustChangePassword).toBe(true);

    const change = await request(ctx.app)
      .post('/api/auth/change-password')
      .set('Cookie', cookie)
      .send({ currentPassword: 'Temp1234', newPassword: 'Sunita123' });
    expect(change.status).toBe(200);
    const me2 = await request(ctx.app).get('/api/auth/me').set('Cookie', cookie);
    expect(me2.body.user.mustChangePassword).toBe(false);

    // audit rows exist for the create
    const auditRow = ctx.db
      .prepare(
        "SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'user' AND action = 'create'",
      )
      .get() as { n: number };
    expect(auditRow.n).toBeGreaterThan(0);
  });

  it('deactivation instantly kills sessions and blocks login', async () => {
    await request(ctx.app)
      .post('/api/users')
      .set('Cookie', adminCookie)
      .send({ username: 'temp1', displayName: 'Temp', role: 'operator', password: 'Temp1234' });
    const cookie = await loginAs(ctx.app, 'temp1', 'Temp1234');
    const id = (ctx.db.prepare("SELECT id FROM users WHERE username='temp1'").get() as { id: number }).id;

    const deact = await request(ctx.app)
      .post(`/api/users/${id}/deactivate`)
      .set('Cookie', adminCookie);
    expect(deact.status).toBe(200);

    expect((await request(ctx.app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(401);
    const relogin = await request(ctx.app)
      .post('/api/auth/login')
      .send({ username: 'temp1', password: 'Temp1234' });
    expect(relogin.status).toBe(401);

    // reactivate restores login
    await request(ctx.app).post(`/api/users/${id}/reactivate`).set('Cookie', adminCookie);
    const again = await request(ctx.app)
      .post('/api/auth/login')
      .send({ username: 'temp1', password: 'Temp1234' });
    expect(again.status).toBe(200);
  });

  it('admin cannot deactivate their own account', async () => {
    const res = await request(ctx.app).post('/api/users/1/deactivate').set('Cookie', adminCookie);
    expect(res.status).toBe(400);
  });

  it('password reset revokes sessions and forces change', async () => {
    await request(ctx.app)
      .post('/api/users')
      .set('Cookie', adminCookie)
      .send({ username: 'temp2', displayName: 'Temp2', role: 'owner', password: 'Temp1234' });
    const cookie = await loginAs(ctx.app, 'temp2', 'Temp1234');
    const id = (ctx.db.prepare("SELECT id FROM users WHERE username='temp2'").get() as { id: number }).id;

    await request(ctx.app)
      .post(`/api/users/${id}/reset-password`)
      .set('Cookie', adminCookie)
      .send({ password: 'Fresh1234' });

    expect((await request(ctx.app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(401);
    const relogin = await request(ctx.app)
      .post('/api/auth/login')
      .send({ username: 'temp2', password: 'Fresh1234' });
    expect(relogin.status).toBe(200);
    expect(relogin.body.user.mustChangePassword).toBe(true);
  });

  it('role change revokes sessions so new permissions apply', async () => {
    await request(ctx.app)
      .post('/api/users')
      .set('Cookie', adminCookie)
      .send({ username: 'temp3', displayName: 'Temp3', role: 'operator', password: 'Temp1234' });
    const cookie = await loginAs(ctx.app, 'temp3', 'Temp1234');
    const id = (ctx.db.prepare("SELECT id FROM users WHERE username='temp3'").get() as { id: number }).id;

    await request(ctx.app)
      .patch(`/api/users/${id}`)
      .set('Cookie', adminCookie)
      .send({ role: 'owner' });

    expect((await request(ctx.app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(401);
    const relogin = await request(ctx.app)
      .post('/api/auth/login')
      .send({ username: 'temp3', password: 'Temp1234' });
    expect(relogin.body.user.role).toBe('owner');
  });
});

describe('migrations', () => {
  it('are idempotent', async () => {
    const { migrate } = await import('../../src/db/migrate');
    expect(migrate(ctx.db)).toEqual([]);
  });

  it('created the full schema', () => {
    const tables = (
      ctx.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[]
    ).map((r) => r.name);
    for (const required of [
      'users', 'sessions', 'audit_log', 'counters', 'settings', 'idempotency_keys',
      'models', 'colors', 'sizes', 'vendors', 'contractors', 'staff',
      'purchases', 'cutting_batches', 'cutting_lines', 'job_cards', 'job_card_lines',
      'job_receipts', 'job_receipt_lines', 'check_issues', 'check_results',
      'check_result_rejections', 'pack_issues', 'pack_results', 'discrepancies',
      'fg_dispatches', 'opening_balances', 'contractor_payments', 'stock_ledger',
      'job_allocations', 'check_allocations', 'pack_allocations',
    ]) {
      expect(tables).toContain(required);
    }
  });
});
