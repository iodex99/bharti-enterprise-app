import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { loginAs, makeTestContext, type TestContext } from '../helpers';

/**
 * Hostile-input edge cases: garbage ids, unknown foreign keys, deactivated masters
 * at entry points. None of these may 500 or crash.
 */
let ctx: TestContext;
let admin: string;
let operator: string;

beforeAll(async () => {
  ctx = await makeTestContext();
  admin = await loginAs(ctx.app, 'admin', 'Admin@123');
  operator = await loginAs(ctx.app, 'operator', 'Operator@123');
  ctx.db.exec(`
    INSERT INTO models (id, code, name, created_by) VALUES (1, 'M1', 'Model 1', 1);
    INSERT INTO models (id, code, name, is_active, created_by) VALUES (2, 'M-OFF', 'Retired', 0, 1);
    INSERT INTO colors (id, name, created_by) VALUES (1, 'Black', 1);
    INSERT INTO sizes (id, code, created_by) VALUES (1, 'XS', 1);
    INSERT INTO vendors (id, name, created_by) VALUES (1, 'V1', 1);
    INSERT INTO contractors (id, name, created_by) VALUES (1, 'C1', 1);
    INSERT INTO staff (id, name, role, created_by) VALUES (1, 'Pooja', 'checker', 1);
  `);
});
afterAll(() => ctx.cleanup());

describe('garbage ids never 500', () => {
  const cases: Array<[string, 'get' | 'post' | 'put' | 'patch', string]> = [
    ['masters', 'put', '/api/masters/models/abc'],
    ['masters delete-ish', 'post', '/api/masters/models/NaN/deactivate'],
    ['users', 'patch', '/api/users/abc'],
    ['purchases void', 'post', '/api/purchases/abc/void'],
    ['cutting actuals', 'post', '/api/cutting/xyz/actuals'],
    ['job receipts', 'post', '/api/jobs/12abc/receipts'],
    ['job receipts read', 'get', '/api/jobs/%20/receipts'],
    ['checking results', 'post', '/api/checking/null/results'],
    ['packing void', 'post', '/api/packing/undefined/void'],
    ['dispatch void', 'post', '/api/dispatches/1e9x/void'],
    ['payments void', 'post', '/api/contractors/payments/--1/void'],
    ['trace fg', 'get', '/api/trace/fg/abc'],
    ['trace purchase', 'get', '/api/trace/purchase/abc'],
  ];
  for (const [name, method, path] of cases) {
    it(`${name}: ${method.toUpperCase()} ${path} -> 404`, async () => {
      const res = await request(ctx.app)[method](path).set('Cookie', admin).send({});
      expect(res.status).toBe(404);
      expect(res.body.error).toBeDefined();
    });
  }
});

describe('unknown foreign keys are 400s, not 500s', () => {
  it('opening balance with unknown model', async () => {
    const res = await request(ctx.app).post('/api/opening-balances').set('Cookie', admin).send({
      balanceDate: '2026-07-01',
      stage: 'FG',
      modelId: 999,
      colorId: 1,
      sizeId: 1,
      qty: 10,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/model not found/i);
  });

  it('job card with unknown model/color', async () => {
    const res = await request(ctx.app)
      .post('/api/jobs')
      .set('Cookie', operator)
      .send({
        issueDate: '2026-07-01',
        contractorId: 1,
        modelId: 999,
        colorId: 1,
        lines: [{ sizeId: 1, qtyIssuedPcs: 12, unitEntered: 'pieces', ratePaisePerDozen: 100 }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/model not found/i);
  });

  it('check issue against an unknown received batch is a clean 400', async () => {
    const res = await request(ctx.app).post('/api/checking').set('Cookie', operator).send({
      issueDate: '2026-07-01',
      staffId: 1,
      lotType: 'receipt_line',
      lotId: 999999,
      qtyPcs: 5,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not found/i);
  });
});

describe('deactivated masters are blocked at entry points', () => {
  it('opening balance on a deactivated model', async () => {
    const res = await request(ctx.app).post('/api/opening-balances').set('Cookie', admin).send({
      balanceDate: '2026-07-01',
      stage: 'FG',
      modelId: 2,
      colorId: 1,
      sizeId: 1,
      qty: 10,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/deactivated/i);
  });

  it('job card on a deactivated model', async () => {
    const res = await request(ctx.app)
      .post('/api/jobs')
      .set('Cookie', operator)
      .send({
        issueDate: '2026-07-01',
        contractorId: 1,
        modelId: 2,
        colorId: 1,
        lines: [{ sizeId: 1, qtyIssuedPcs: 12, unitEntered: 'pieces', ratePaisePerDozen: 100 }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/deactivated/i);
  });
});

describe('assorted hostile input', () => {
  it('huge numbers are rejected by schema bounds', async () => {
    const res = await request(ctx.app).post('/api/purchases').set('Cookie', operator).send({
      purchaseDate: '2026-07-01',
      receivedDate: '2026-07-01',
      vendorId: 1,
      colorId: 1,
      qtyCm: 9_000_000_000,
      ratePaisePerMeter: 100,
      notes: '',
    });
    expect(res.status).toBe(400);
  });

  it('non-integer quantities are rejected', async () => {
    const res = await request(ctx.app).post('/api/purchases').set('Cookie', operator).send({
      purchaseDate: '2026-07-01',
      receivedDate: '2026-07-01',
      vendorId: 1,
      colorId: 1,
      qtyCm: 100.5,
      ratePaisePerMeter: 100,
      notes: '',
    });
    expect(res.status).toBe(400);
  });

  it('malformed JSON body is a 400, not a crash', async () => {
    const res = await request(ctx.app)
      .post('/api/purchases')
      .set('Cookie', operator)
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    expect(res.status).toBe(400);
  });

  it('unicode survives round-trips', async () => {
    const create = await request(ctx.app)
      .post('/api/masters/colors')
      .set('Cookie', admin)
      .send({ name: 'गुलाबी 🌸', colorCode: '#FF69B4' });
    expect(create.status).toBe(201);
    const list = await request(ctx.app).get('/api/masters/colors?q=गुलाबी').set('Cookie', admin);
    expect(list.body.items.some((c: { name: string }) => c.name === 'गुलाबी 🌸')).toBe(true);
  });
});
