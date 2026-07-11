import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import request from 'supertest';
import { loginAs, makeTestContext, type TestContext } from '../helpers';

/**
 * In-app demo mode: a physically separate database, entered/exited/removed with
 * admin buttons. Real data must be provably untouched throughout.
 */
let ctx: TestContext;
let admin: string;
let operator: string;

beforeAll(async () => {
  ctx = await makeTestContext();
  admin = await loginAs(ctx.app, 'admin', 'Admin@123');
  operator = await loginAs(ctx.app, 'operator', 'Operator@123');
  // one real master so we can prove real data is untouched by demo activity
  ctx.db.exec("INSERT INTO models (code, name, created_by) VALUES ('REAL-1', 'Real Model', 1)");
});
afterAll(() => ctx.cleanup());

describe('demo mode lifecycle', () => {
  it('starts inactive with no demo database', async () => {
    const res = await request(ctx.app).get('/api/system/demo').set('Cookie', admin);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ active: false, demoExists: false });
    const health = await request(ctx.app).get('/api/system/health');
    expect(health.body.demoMode).toBe(false);
  });

  it('is admin-only', async () => {
    expect((await request(ctx.app).get('/api/system/demo').set('Cookie', operator)).status).toBe(403);
    expect(
      (await request(ctx.app).post('/api/system/demo/enter').set('Cookie', operator)).status,
    ).toBe(403);
  });

  it('enter builds the demo db, switches over, and invalidates real sessions', async () => {
    const res = await request(ctx.app).post('/api/system/demo/enter').set('Cookie', admin);
    expect(res.status).toBe(200);

    const health = await request(ctx.app).get('/api/system/health');
    expect(health.body.demoMode).toBe(true);

    // the real session cookie means nothing in the demo database
    const me = await request(ctx.app).get('/api/auth/me').set('Cookie', admin);
    expect(me.status).toBe(401);

    // demo credentials work and demo content is there
    const demoAdmin = await loginAs(ctx.app, 'admin', 'Admin@123');
    const contractors = await request(ctx.app)
      .get('/api/masters/contractors')
      .set('Cookie', demoAdmin);
    expect(
      contractors.body.items.some(
        (c: { name: string }) => c.name === 'Meena Stitching Works',
      ),
    ).toBe(true);

    // demo dashboard is populated
    const dash = await request(ctx.app).get('/api/dashboard').set('Cookie', demoAdmin);
    expect(dash.body.kpis.fgPcs).toBeGreaterThan(0);
    expect(dash.body.kpis.delayedJobs).toBeGreaterThan(0); // the seeded delayed job

    // demo reconciliation is green
    const recon = await request(ctx.app)
      .get('/api/system/reconciliation')
      .set('Cookie', demoAdmin);
    expect(recon.body.ok).toBe(true);

    // real model does NOT exist in the demo db
    const models = await request(ctx.app).get('/api/masters/models').set('Cookie', demoAdmin);
    expect(models.body.items.some((m: { code: string }) => m.code === 'REAL-1')).toBe(false);
  });

  it('cannot remove demo data while active; cannot enter twice', async () => {
    const demoAdmin = await loginAs(ctx.app, 'admin', 'Admin@123');
    expect(
      (await request(ctx.app).post('/api/system/demo/remove').set('Cookie', demoAdmin)).status,
    ).toBe(409);
    expect(
      (await request(ctx.app).post('/api/system/demo/enter').set('Cookie', demoAdmin)).status,
    ).toBe(409);
  });

  it('demo-mode writes stay in the demo database', async () => {
    const demoAdmin = await loginAs(ctx.app, 'admin', 'Admin@123');
    const create = await request(ctx.app)
      .post('/api/masters/colors')
      .set('Cookie', demoAdmin)
      .send({ name: 'Demo Only Color' });
    expect(create.status).toBe(201);
  });

  it('exit returns to the real database exactly as it was', async () => {
    const demoAdmin = await loginAs(ctx.app, 'admin', 'Admin@123');
    const res = await request(ctx.app).post('/api/system/demo/exit').set('Cookie', demoAdmin);
    expect(res.status).toBe(200);

    const health = await request(ctx.app).get('/api/system/health');
    expect(health.body.demoMode).toBe(false);

    // real login works; real data intact; demo writes invisible
    const realAdmin = await loginAs(ctx.app, 'admin', 'Admin@123');
    const models = await request(ctx.app).get('/api/masters/models').set('Cookie', realAdmin);
    expect(models.body.items.some((m: { code: string }) => m.code === 'REAL-1')).toBe(true);
    const colors = await request(ctx.app).get('/api/masters/colors').set('Cookie', realAdmin);
    expect(colors.body.items.some((c: { name: string }) => c.name === 'Demo Only Color')).toBe(false);
    const contractors = await request(ctx.app)
      .get('/api/masters/contractors')
      .set('Cookie', realAdmin);
    expect(contractors.body.items).toHaveLength(0);

    // enter+exit audits are recorded in the REAL database (ctx.db is a stale handle
    // after the connection swap, so assert through the API)
    const auditRes = await request(ctx.app)
      .get('/api/audit?entityType=system')
      .set('Cookie', realAdmin);
    const actions = (auditRes.body.entries as Array<{ action: string }>).map((e) => e.action);
    expect(actions).toContain('demo_enter');
    expect(actions).toContain('demo_exit');
  });

  it('re-enter reuses the existing demo db (demo color persists), fresh rebuilds it', async () => {
    const realAdmin = await loginAs(ctx.app, 'admin', 'Admin@123');
    await request(ctx.app).post('/api/system/demo/enter').set('Cookie', realAdmin);
    let demoAdmin = await loginAs(ctx.app, 'admin', 'Admin@123');
    let colors = await request(ctx.app).get('/api/masters/colors').set('Cookie', demoAdmin);
    expect(colors.body.items.some((c: { name: string }) => c.name === 'Demo Only Color')).toBe(true);
    await request(ctx.app).post('/api/system/demo/exit').set('Cookie', demoAdmin);

    const realAdmin2 = await loginAs(ctx.app, 'admin', 'Admin@123');
    await request(ctx.app).post('/api/system/demo/enter?fresh=1').set('Cookie', realAdmin2);
    demoAdmin = await loginAs(ctx.app, 'admin', 'Admin@123');
    colors = await request(ctx.app).get('/api/masters/colors').set('Cookie', demoAdmin);
    expect(colors.body.items.some((c: { name: string }) => c.name === 'Demo Only Color')).toBe(false);
    await request(ctx.app).post('/api/system/demo/exit').set('Cookie', demoAdmin);
  });

  it('remove deletes the demo database when inactive', async () => {
    const realAdmin = await loginAs(ctx.app, 'admin', 'Admin@123');
    const res = await request(ctx.app).post('/api/system/demo/remove').set('Cookie', realAdmin);
    expect(res.status).toBe(200);
    const status = await request(ctx.app).get('/api/system/demo').set('Cookie', realAdmin);
    expect(status.body.demoExists).toBe(false);
    expect(fs.existsSync(`${ctx.dir}-demo`)).toBe(false);

    const removeAgain = await request(ctx.app)
      .post('/api/system/demo/remove')
      .set('Cookie', realAdmin);
    expect(removeAgain.status).toBe(404);
  });
});
