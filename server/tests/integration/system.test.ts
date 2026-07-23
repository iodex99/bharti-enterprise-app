import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { loginAs, makeTestContext, type TestContext } from '../helpers';

let ctx: TestContext;
let admin: string;
let operator: string;

beforeAll(async () => {
  ctx = await makeTestContext();
  admin = await loginAs(ctx.app, 'admin', 'Admin@123');
  operator = await loginAs(ctx.app, 'operator', 'Operator@123');
  ctx.db.exec(`
    INSERT INTO models (id, code, name, created_by) VALUES (1, 'M1', 'Model 1', 1);
    INSERT INTO colors (id, name, created_by) VALUES (1, 'Black', 1);
    INSERT INTO sizes (id, code, created_by) VALUES (1, 'XS', 1);
    INSERT INTO vendors (id, name, created_by) VALUES (1, 'V1', 1);
  `);
  await request(ctx.app).post('/api/purchases').set('Cookie', operator).send({
    purchaseDate: '2026-07-01',
    receivedDate: '2026-07-01',
    vendorId: 1,
    colorId: 1,
    qtyCm: 10000,
    ratePaisePerMeter: 4000,
    notes: '',
  });
});
afterAll(() => ctx.cleanup());

describe('reconciliation', () => {
  it('passes on a healthy ledger', async () => {
    const res = await request(ctx.app).get('/api/system/reconciliation').set('Cookie', admin);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.checks.length).toBeGreaterThanOrEqual(5);
    for (const check of res.body.checks) expect(check.ok).toBe(true);
  });

  it('is admin-only', async () => {
    expect(
      (await request(ctx.app).get('/api/system/reconciliation').set('Cookie', operator)).status,
    ).toBe(403);
  });

  it('detects deliberately corrupted ledger rows', async () => {
    // simulate the kind of damage only a manual DB edit could cause
    ctx.db
      .prepare(
        `INSERT INTO stock_ledger (stage, model_id, color_id, size_id, lot_type, lot_id, qty, ref_type, ref_id, created_by)
         VALUES ('CUT', 1, 1, 1, 'cutting_line', 999, -5, 'job_issue', 999, 1)`,
      )
      .run();
    const res = await request(ctx.app).get('/api/system/reconciliation').set('Cookie', admin);
    expect(res.body.ok).toBe(false);
    const failed = (res.body.checks as Array<{ name: string; ok: boolean }>).filter((c) => !c.ok);
    // one bad row trips both the negative-lot and unbalanced-transfer checks
    expect(failed.map((c) => c.name)).toContain('No negative stock lots');
    expect(failed.map((c) => c.name)).toContain('Every transfer is balanced');
    // clean up the sabotage
    ctx.db.prepare("DELETE FROM stock_ledger WHERE lot_id = 999 AND ref_id = 999").run();
  });
});

describe('settings', () => {
  it('round-trips whitelisted settings with audit', async () => {
    const initial = await request(ctx.app).get('/api/system/settings').set('Cookie', admin);
    expect(initial.body.settings.delayed_job_days).toBe('7'); // default

    const save = await request(ctx.app)
      .put('/api/system/settings')
      .set('Cookie', admin)
      .send({ key: 'delayed_job_days', value: '10' });
    expect(save.status).toBe(200);

    const after = await request(ctx.app).get('/api/system/settings').set('Cookie', admin);
    expect(after.body.settings.delayed_job_days).toBe('10');

    const auditRow = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'setting'")
      .get() as { n: number };
    expect(auditRow.n).toBe(1);
  });

  it('rejects unknown keys and bad values', async () => {
    const unknown = await request(ctx.app)
      .put('/api/system/settings')
      .set('Cookie', admin)
      .send({ key: 'hax', value: '1' });
    expect(unknown.status).toBe(400);

    const bad = await request(ctx.app)
      .put('/api/system/settings')
      .set('Cookie', admin)
      .send({ key: 'delayed_job_days', value: 'soon' });
    expect(bad.status).toBe(400);

    const zero = await request(ctx.app)
      .put('/api/system/settings')
      .set('Cookie', admin)
      .send({ key: 'delayed_job_days', value: '0' });
    expect(zero.status).toBe(400);
  });

  it('operators cannot read or write settings', async () => {
    expect((await request(ctx.app).get('/api/system/settings').set('Cookie', operator)).status).toBe(403);
    expect(
      (
        await request(ctx.app)
          .put('/api/system/settings')
          .set('Cookie', operator)
          .send({ key: 'delayed_job_days', value: '9' })
      ).status,
    ).toBe(403);
  });
});
