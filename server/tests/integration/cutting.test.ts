import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { clothRequiredCm } from '@shared';
import { loginAs, makeTestContext, type TestContext } from '../helpers';

/**
 * Cutting with computed consumption: each line carries cloth-per-piece (hundredths of an
 * inch) and how many pieces fit across the width; the server computes the cm consumed.
 * The MODEL is chosen at cutting (purchases have none). Plans are editable/deletable
 * while still 'planned'.
 */
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
    INSERT INTO models (id, code, name, created_by) VALUES (1, 'M1', 'Model 1', 1), (2, 'M2', 'Model 2', 1);
    INSERT INTO colors (id, name, created_by) VALUES (1, 'Black', 1);
    INSERT INTO sizes (id, code, sort_order, created_by) VALUES (1, 'XS', 1, 1), (2, 'S1', 2, 1), (3, 'XL', 3, 1);
    INSERT INTO vendors (id, name, created_by) VALUES (1, 'V1', 1);
  `);
  const purchase = await request(ctx.app).post('/api/purchases').set('Cookie', operator).send({
    purchaseDate: '2026-07-01',
    receivedDate: '2026-07-01',
    vendorId: 1,
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

// geometry used throughout: XS 10" ×3 across, S1 9" ×3, XL 14" ×2
const GEO: Record<number, { c: number; w: number }> = {
  1: { c: 1000, w: 3 },
  2: { c: 900, w: 3 },
  3: { c: 1400, w: 2 },
};
const line = (sizeId: number, expectedPcs: number) => ({
  sizeId,
  expectedPcs,
  clothPerPcInchC: GEO[sizeId]!.c,
  widthCount: GEO[sizeId]!.w,
});
const cmFor = (sizeId: number, pcs: number) =>
  clothRequiredCm(pcs, GEO[sizeId]!.c, GEO[sizeId]!.w);

describe('cutting', () => {
  let batchId: number;

  it('plan computes cloth from geometry, consumes it and stores expected lines', async () => {
    const res = await request(ctx.app)
      .post('/api/cutting')
      .set('Cookie', operator)
      .send({
        cutDate: '2026-07-02',
        rawLotType: 'purchase',
        rawLotId: purchaseId,
        modelId: 1, // the model is decided HERE
        notes: '',
        lines: [line(1, 120), line(2, 180), line(3, 60)],
      });
    expect(res.status).toBe(201);
    expect(res.body.docNo).toBe('CUT-0001');
    batchId = res.body.id as number;

    // 120 XS: 40 strips × 10" = 400" = exactly 1016 cm; S1: ceil(1371.6)=1372; XL: ceil(30×14×2.54)=1067
    const expectedCm = cmFor(1, 120) + cmFor(2, 180) + cmFor(3, 60);
    expect(cmFor(1, 120)).toBe(1016);
    expect(rawBalance()).toBe(20000 - expectedCm);

    const list = await request(ctx.app).get('/api/cutting').set('Cookie', owner);
    expect(list.status).toBe(200);
    const batch = list.body.items.find((b: { id: number }) => b.id === batchId);
    expect(batch.status).toBe('planned');
    expect(batch.modelCode).toBe('M1');
    expect(batch.metersUsedCm).toBe(expectedCm);
    expect(batch.expectedTotalPcs).toBe(360);
    expect(batch.actualTotalPcs).toBeNull();
    expect(batch.rawDocNo).toBe('RM-0001');
    expect(batch.lines[0].clothPerPcInchC).toBe(1000);
    expect(batch.lines[0].widthCount).toBe(3);
  });

  it('rejects over-consumption, duplicate sizes, unknown lots and missing geometry', async () => {
    const tooMuch = await request(ctx.app)
      .post('/api/cutting')
      .set('Cookie', operator)
      .send({
        cutDate: '2026-07-02',
        rawLotType: 'purchase',
        rawLotId: purchaseId,
        modelId: 1,
        lines: [line(1, 120000)], // 40000 strips × 10" ≈ 10 km of cloth
      });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.error).toMatch(/has only .* available/i);

    const dupSizes = await request(ctx.app)
      .post('/api/cutting')
      .set('Cookie', operator)
      .send({
        cutDate: '2026-07-02',
        rawLotType: 'purchase',
        rawLotId: purchaseId,
        modelId: 1,
        lines: [line(1, 12), line(1, 24)],
      });
    expect(dupSizes.status).toBe(400);

    const badLot = await request(ctx.app)
      .post('/api/cutting')
      .set('Cookie', operator)
      .send({
        cutDate: '2026-07-02',
        rawLotType: 'purchase',
        rawLotId: 9999,
        modelId: 1,
        lines: [line(1, 12)],
      });
    expect(badLot.status).toBe(400);

    // geometry is mandatory on every plan line
    const noGeometry = await request(ctx.app)
      .post('/api/cutting')
      .set('Cookie', operator)
      .send({
        cutDate: '2026-07-02',
        rawLotType: 'purchase',
        rawLotId: purchaseId,
        modelId: 1,
        lines: [{ sizeId: 1, expectedPcs: 12 }],
      });
    expect(noGeometry.status).toBe(400);
  });

  it('edit re-plans a planned batch: cloth returned, recomputed, doc number kept', async () => {
    const before = rawBalance();
    const plan = await request(ctx.app)
      .post('/api/cutting')
      .set('Cookie', operator)
      .send({
        cutDate: '2026-07-02',
        rawLotType: 'purchase',
        rawLotId: purchaseId,
        modelId: 1,
        lines: [line(1, 24)],
      });
    const id = plan.body.id as number;
    const docNo = plan.body.docNo as string;
    expect(rawBalance()).toBe(before - cmFor(1, 24));

    // change size, quantity AND model
    const edited = await request(ctx.app)
      .put(`/api/cutting/${id}`)
      .set('Cookie', operator)
      .send({
        cutDate: '2026-07-03',
        rawLotType: 'purchase',
        rawLotId: purchaseId,
        modelId: 2,
        lines: [line(2, 36)],
      });
    expect(edited.status).toBe(200);
    expect(rawBalance()).toBe(before - cmFor(2, 36)); // old cloth back, new consumed

    const list = await request(ctx.app).get('/api/cutting').set('Cookie', operator);
    const batch = list.body.items.find((b: { id: number }) => b.id === id);
    expect(batch.docNo).toBe(docNo); // number survives the edit
    expect(batch.modelCode).toBe('M2');
    expect(batch.lines).toHaveLength(1);
    expect(batch.lines[0].sizeId).toBe(2);
    expect(batch.lines[0].expectedPcs).toBe(36);

    // an edit that would overdraw the lot is refused and changes nothing
    const tooBig = await request(ctx.app)
      .put(`/api/cutting/${id}`)
      .set('Cookie', operator)
      .send({
        cutDate: '2026-07-03',
        rawLotType: 'purchase',
        rawLotId: purchaseId,
        modelId: 2,
        lines: [line(2, 120000)],
      });
    expect(tooBig.status).toBe(409);
    expect(rawBalance()).toBe(before - cmFor(2, 36));

    // delete restores the cloth (soft: void with a standard reason)
    const del = await request(ctx.app).delete(`/api/cutting/${id}`).set('Cookie', operator);
    expect(del.status).toBe(200);
    expect(rawBalance()).toBe(before);
    const voided = ctx.db
      .prepare('SELECT voided_at, void_reason FROM cutting_batches WHERE id = ?')
      .get(id) as { voided_at: string | null; void_reason: string };
    expect(voided.voided_at).not.toBeNull();
    expect(voided.void_reason).toMatch(/deleted before cutting/i);
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

  it('records actuals incl. unplanned size; CUT stock and discrepancies follow; edit then blocked', async () => {
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

    // once actuals exist the plan is frozen: no edit, no operator delete
    const editAfter = await request(ctx.app)
      .put(`/api/cutting/${batchId}`)
      .set('Cookie', operator)
      .send({
        cutDate: '2026-07-03',
        rawLotType: 'purchase',
        rawLotId: purchaseId,
        modelId: 1,
        lines: [line(1, 12)],
      });
    expect(editAfter.status).toBe(409);
    const delAfter = await request(ctx.app).delete(`/api/cutting/${batchId}`).set('Cookie', operator);
    expect(delAfter.status).toBe(409);
  });

  it('supports unplanned sizes at actual time', async () => {
    const plan = await request(ctx.app)
      .post('/api/cutting')
      .set('Cookie', operator)
      .send({
        cutDate: '2026-07-03',
        rawLotType: 'purchase',
        rawLotId: purchaseId,
        modelId: 1,
        lines: [line(1, 48)],
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
    const dbLine = ctx.db
      .prepare('SELECT expected_pcs, actual_pcs FROM cutting_lines WHERE cutting_batch_id = ? AND size_id = 3')
      .get(id) as { expected_pcs: number; actual_pcs: number };
    expect(dbLine.expected_pcs).toBe(0);
    expect(dbLine.actual_pcs).toBe(12);
  });

  it('owner cannot create plans; operator cannot void a completed batch', async () => {
    const asOwner = await request(ctx.app)
      .post('/api/cutting')
      .set('Cookie', owner)
      .send({
        cutDate: '2026-07-02',
        rawLotType: 'purchase',
        rawLotId: purchaseId,
        modelId: 1,
        lines: [line(1, 12)],
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
        modelId: 1,
        lines: [line(2, 24)],
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

  it('cuts from an opening-balance raw lot too (opening RAW has no model)', async () => {
    const opening = await request(ctx.app)
      .post('/api/opening-balances')
      .set('Cookie', admin)
      .send({ balanceDate: '2026-07-01', stage: 'RAW', colorId: 1, qty: 3000, note: '' });
    expect(opening.status).toBe(201);
    const plan = await request(ctx.app)
      .post('/api/cutting')
      .set('Cookie', operator)
      .send({
        cutDate: '2026-07-05',
        rawLotType: 'opening',
        rawLotId: opening.body.id,
        modelId: 1,
        lines: [line(1, 72)], // 24 strips × 10" = 609.6 → 610 cm
      });
    expect(plan.status).toBe(201);
    const openingBal = (
      ctx.db
        .prepare(
          "SELECT COALESCE(SUM(qty),0) AS q FROM stock_ledger WHERE stage='RAW' AND lot_type='opening' AND lot_id=?",
        )
        .get(opening.body.id) as { q: number }
    ).q;
    expect(openingBal).toBe(3000 - cmFor(1, 72));
  });
});
