import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { loginAs, makeTestContext, type TestContext } from '../helpers';

let ctx: TestContext;
let admin: string;
let operator: string;
let owner: string;
let purchaseId: number;

beforeAll(async () => {
  ctx = await makeTestContext();
  admin = await loginAs(ctx.app, 'admin', 'Admin@123');
  operator = await loginAs(ctx.app, 'operator', 'Operator@123');
  owner = await loginAs(ctx.app, 'owner', 'Owner@123');
  ctx.db.exec(`
    INSERT INTO models (id, code, name, created_by) VALUES (1, 'M1', 'Model 1', 1);
    INSERT INTO colors (id, name, created_by) VALUES (1, 'Black', 1);
    INSERT INTO sizes (id, code, sort_order, created_by) VALUES (1, 'XS', 1, 1), (2, 'S1', 2, 1), (3, 'XL', 3, 1);
    INSERT INTO vendors (id, name, created_by) VALUES (1, 'V1', 1);
  `);
  const purchase = await request(ctx.app).post('/api/purchases').set('Cookie', operator).send({
    purchaseDate: '2026-07-01',
    receivedDate: '2026-07-01',
    vendorId: 1,
    modelId: 1,
    colorId: 1,
    qtyCm: 20000, // 200 m
    ratePaisePerMeter: 4000,
    notes: '',
  });
  purchaseId = purchase.body.id as number;
});
afterAll(() => ctx.cleanup());

const rawBalance = () =>
  (
    ctx.db
      .prepare(
        "SELECT COALESCE(SUM(qty),0) AS q FROM stock_ledger WHERE stage='RAW' AND lot_type='purchase' AND lot_id=?",
      )
      .get(purchaseId) as { q: number }
  ).q;

describe('cutting', () => {
  let batchId: number;

  it('plan consumes raw meters and stores expected lines', async () => {
    const res = await request(ctx.app)
      .post('/api/cutting')
      .set('Cookie', operator)
      .send({
        cutDate: '2026-07-02',
        rawLotType: 'purchase',
        rawLotId: purchaseId,
        metersUsedCm: 8000, // 80 m
        notes: '',
        lines: [
          { sizeId: 1, expectedPcs: 120 }, // 10 dz
          { sizeId: 2, expectedPcs: 180 }, // 15 dz
          { sizeId: 3, expectedPcs: 60 }, // 5 dz
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.docNo).toBe('CUT-0001');
    batchId = res.body.id as number;
    expect(rawBalance()).toBe(12000); // 200m - 80m

    const list = await request(ctx.app).get('/api/cutting').set('Cookie', owner);
    expect(list.status).toBe(200);
    const batch = list.body.items.find((b: { id: number }) => b.id === batchId);
    expect(batch.status).toBe('planned');
    expect(batch.expectedTotalPcs).toBe(360);
    expect(batch.actualTotalPcs).toBeNull();
    expect(batch.rawDocNo).toBe('RM-0001');
  });

  it('rejects over-consumption, duplicate sizes and unknown lots', async () => {
    const tooMuch = await request(ctx.app)
      .post('/api/cutting')
      .set('Cookie', operator)
      .send({
        cutDate: '2026-07-02',
        rawLotType: 'purchase',
        rawLotId: purchaseId,
        metersUsedCm: 999999,
        lines: [{ sizeId: 1, expectedPcs: 12 }],
      });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.error).toMatch(/only .* available/i);

    const dupSizes = await request(ctx.app)
      .post('/api/cutting')
      .set('Cookie', operator)
      .send({
        cutDate: '2026-07-02',
        rawLotType: 'purchase',
        rawLotId: purchaseId,
        metersUsedCm: 100,
        lines: [
          { sizeId: 1, expectedPcs: 12 },
          { sizeId: 1, expectedPcs: 24 },
        ],
      });
    expect(dupSizes.status).toBe(400);

    const badLot = await request(ctx.app)
      .post('/api/cutting')
      .set('Cookie', operator)
      .send({
        cutDate: '2026-07-02',
        rawLotType: 'purchase',
        rawLotId: 9999,
        metersUsedCm: 100,
        lines: [{ sizeId: 1, expectedPcs: 12 }],
      });
    expect(badLot.status).toBe(400);
  });

  it('actuals require a reason for every variance', async () => {
    const missingReason = await request(ctx.app)
      .post(`/api/cutting/${batchId}/actuals`)
      .set('Cookie', operator)
      .send({
        lines: [
          { sizeId: 1, actualPcs: 108 }, // -12 vs expected, no reason
          { sizeId: 2, actualPcs: 180 },
          { sizeId: 3, actualPcs: 60 },
        ],
      });
    expect(missingReason.status).toBe(400);
    expect(missingReason.body.error).toMatch(/reason/i);

    const missingLine = await request(ctx.app)
      .post(`/api/cutting/${batchId}/actuals`)
      .set('Cookie', operator)
      .send({ lines: [{ sizeId: 1, actualPcs: 108, varianceReason: 'wastage' }] });
    expect(missingLine.status).toBe(400);
    expect(missingLine.body.error).toMatch(/every planned size/i);
  });

  it('records actuals incl. unplanned size; CUT stock and discrepancies follow', async () => {
    const res = await request(ctx.app)
      .post(`/api/cutting/${batchId}/actuals`)
      .set('Cookie', operator)
      .send({
        lines: [
          { sizeId: 1, actualPcs: 108, varianceReason: 'wastage', reasonNote: 'edge damage' }, // 9 dz (-1)
          { sizeId: 2, actualPcs: 192, varianceReason: 'better_yield' }, // 16 dz (+1)
          { sizeId: 3, actualPcs: 60 }, // exact
        ],
      });
    expect(res.status).toBe(200);

    const list = await request(ctx.app).get('/api/cutting').set('Cookie', operator);
    const batch = list.body.items.find((b: { id: number }) => b.id === batchId);
    expect(batch.status).toBe('completed');
    expect(batch.actualTotalPcs).toBe(360);
    expect(batch.variancePct).toBe(0); // -12 +12 nets out
    const lineXS = batch.lines.find((l: { sizeCode: string }) => l.sizeCode === 'XS');
    expect(lineXS.actualPcs).toBe(108);
    expect(lineXS.varianceReason).toBe('wastage');

    const cutStock = await request(ctx.app).get('/api/stock/CUT').set('Cookie', owner);
    const total = cutStock.body.items.reduce((s: number, r: { qty: number }) => s + r.qty, 0);
    expect(total).toBe(360);

    const discrepancies = (
      ctx.db
        .prepare("SELECT COUNT(*) AS n FROM discrepancies WHERE stage='CUT'")
        .get() as { n: number }
    ).n;
    expect(discrepancies).toBe(2); // XS -12, S1 +12

    const again = await request(ctx.app)
      .post(`/api/cutting/${batchId}/actuals`)
      .set('Cookie', operator)
      .send({ lines: [{ sizeId: 1, actualPcs: 1, varianceReason: 'other' }] });
    expect(again.status).toBe(409);
  });

  it('supports unplanned sizes at actual time', async () => {
    const plan = await request(ctx.app)
      .post('/api/cutting')
      .set('Cookie', operator)
      .send({
        cutDate: '2026-07-03',
        rawLotType: 'purchase',
        rawLotId: purchaseId,
        metersUsedCm: 2000,
        lines: [{ sizeId: 1, expectedPcs: 48 }],
      });
    const id = plan.body.id as number;
    const res = await request(ctx.app)
      .post(`/api/cutting/${id}/actuals`)
      .set('Cookie', operator)
      .send({
        lines: [
          { sizeId: 1, actualPcs: 48 },
          { sizeId: 3, actualPcs: 12, varianceReason: 'other', reasonNote: 'leftover strip cut as XL' },
        ],
      });
    expect(res.status).toBe(200);
    const line = ctx.db
      .prepare('SELECT expected_pcs, actual_pcs FROM cutting_lines WHERE cutting_batch_id = ? AND size_id = 3')
      .get(id) as { expected_pcs: number; actual_pcs: number };
    expect(line.expected_pcs).toBe(0);
    expect(line.actual_pcs).toBe(12);
  });

  it('owner cannot create plans; operator cannot void', async () => {
    const asOwner = await request(ctx.app)
      .post('/api/cutting')
      .set('Cookie', owner)
      .send({
        cutDate: '2026-07-02',
        rawLotType: 'purchase',
        rawLotId: purchaseId,
        metersUsedCm: 100,
        lines: [{ sizeId: 1, expectedPcs: 12 }],
      });
    expect(asOwner.status).toBe(403);

    const asOperator = await request(ctx.app)
      .post(`/api/cutting/${batchId}/void`)
      .set('Cookie', operator)
      .send({ reason: 'nope' });
    expect(asOperator.status).toBe(403);
  });

  it('void restores RAW and removes CUT while unconsumed; blocked after consumption', async () => {
    const before = rawBalance();
    const plan = await request(ctx.app)
      .post('/api/cutting')
      .set('Cookie', operator)
      .send({
        cutDate: '2026-07-04',
        rawLotType: 'purchase',
        rawLotId: purchaseId,
        metersUsedCm: 1000,
        lines: [{ sizeId: 2, expectedPcs: 24 }],
      });
    const id = plan.body.id as number;
    await request(ctx.app)
      .post(`/api/cutting/${id}/actuals`)
      .set('Cookie', operator)
      .send({ lines: [{ sizeId: 2, actualPcs: 24 }] });

    const voided = await request(ctx.app)
      .post(`/api/cutting/${id}/void`)
      .set('Cookie', admin)
      .send({ reason: 'test void' });
    expect(voided.status).toBe(200);
    expect(rawBalance()).toBe(before); // meters restored

    // now simulate downstream consumption on the FIRST batch and try voiding it
    const lineId = (
      ctx.db
        .prepare('SELECT id FROM cutting_lines WHERE cutting_batch_id = ? AND size_id = 1')
        .get(batchId) as { id: number }
    ).id;
    ctx.db
      .prepare(
        `INSERT INTO stock_ledger (stage, model_id, color_id, size_id, lot_type, lot_id, qty, ref_type, ref_id, created_by)
         VALUES ('CUT', 1, 1, 1, 'cutting_line', ?, -12, 'adjustment_out', 999, 1)`,
      )
      .run(lineId);
    const blocked = await request(ctx.app)
      .post(`/api/cutting/${batchId}/void`)
      .set('Cookie', admin)
      .send({ reason: 'should fail' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/already issued/i);
  });

  it('cuts from an opening-balance raw lot too', async () => {
    const opening = await request(ctx.app)
      .post('/api/opening-balances')
      .set('Cookie', admin)
      .send({ balanceDate: '2026-07-01', stage: 'RAW', modelId: 1, colorId: 1, qty: 3000, note: '' });
    const plan = await request(ctx.app)
      .post('/api/cutting')
      .set('Cookie', operator)
      .send({
        cutDate: '2026-07-05',
        rawLotType: 'opening',
        rawLotId: opening.body.id,
        metersUsedCm: 3000,
        lines: [{ sizeId: 1, expectedPcs: 72 }],
      });
    expect(plan.status).toBe(201);
    const openingBal = (
      ctx.db
        .prepare(
          "SELECT COALESCE(SUM(qty),0) AS q FROM stock_ledger WHERE stage='RAW' AND lot_type='opening' AND lot_id=?",
        )
        .get(opening.body.id) as { q: number }
    ).q;
    expect(openingBal).toBe(0);
  });
});
