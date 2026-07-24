import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { clothRequiredInchC } from '@shared';
import { loginAs, makeTestContext, type TestContext } from '../helpers';

/**
 * Cutting v2 (ADR-030/031): the plan IS the cutting — one POST consumes the cloth AND
 * creates the CUT pieces. The CODE typed per line creates the product identity, and
 * entries stay editable/deletable until their pieces move downstream.
 */
let ctx: TestContext;
let admin: string;
let operator: string;
let owner: string;

const lotBalance = (lotType: string, lotId: number, stage = 'RAW') =>
  (
    ctx.db
      .prepare(
        'SELECT COALESCE(SUM(qty),0) AS q FROM stock_ledger WHERE stage=? AND lot_type=? AND lot_id=?',
      )
      .get(stage, lotType, lotId) as { q: number }
  ).q;

async function makePurchase(lenInchC = 360000): Promise<number> {
  const res = await request(ctx.app).post('/api/purchases').set('Cookie', operator).send({
    purchaseDate: '2026-07-01',
    receivedDate: '2026-07-01',
    vendorId: 1,
    colorId: 1,
    lenInchC, // default 100 yd
    widthInchC: 4400,
    ratePaisePerYard: 4000,
    notes: '',
  });
  if (res.status !== 201) throw new Error(`purchase failed: ${res.text}`);
  return res.body.id as number;
}

beforeAll(async () => {
  ctx = await makeTestContext();
  admin = await loginAs(ctx.app, 'admin', 'Admin@123');
  operator = await loginAs(ctx.app, 'operator', 'Operator@123');
  owner = await loginAs(ctx.app, 'owner', 'Owner@123');
  ctx.db.exec(`
    INSERT INTO colors (id, name, created_by) VALUES (1, 'Black', 1);
    INSERT INTO sizes (id, code, sort_order, created_by) VALUES (1, 'XS', 1, 1), (2, 'S1', 2, 1);
    INSERT INTO vendors (id, name, created_by) VALUES (1, 'V1', 1);
    INSERT INTO contractors (id, name, created_by) VALUES (1, 'C1', 1);
  `);
});
afterAll(() => ctx.cleanup());

describe('cutting v2', () => {
  it('one POST cuts: cloth consumed from geometry, CUT stock created, code born', async () => {
    const purchaseId = await makePurchase();
    // 120 pcs @10" ×4 across = 30 strips = 30000 inch_c; 96 pcs @9" ×4 = 24 strips = 21600
    const res = await request(ctx.app)
      .post('/api/cutting')
      .set('Cookie', operator)
      .send({
        cutDate: '2026-07-02',
        rawLotType: 'purchase',
        rawLotId: purchaseId,
        notes: '',
        lines: [
          { sizeId: 1, code: '315', qtyPcs: 120, clothPerPcInchC: 1000, widthCount: 4 },
          { sizeId: 2, code: '315', qtyPcs: 96, clothPerPcInchC: 900, widthCount: 4 },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.docNo).toBe('CUT-0001');

    const expected =
      clothRequiredInchC(120, 1000, 4) + clothRequiredInchC(96, 900, 4);
    expect(expected).toBe(30000 + 21600);
    expect(lotBalance('purchase', purchaseId)).toBe(360000 - expected);

    // the product identity was created from the typed code
    const model = ctx.db
      .prepare("SELECT id, code FROM models WHERE code = '315'")
      .get() as { id: number; code: string };
    expect(model).toBeTruthy();

    // CUT stock exists immediately — no separate actuals step
    const lines = ctx.db
      .prepare('SELECT id, size_id, model_id, expected_pcs, actual_pcs FROM cutting_lines WHERE cutting_batch_id = ?')
      .all(res.body.id) as Array<{ id: number; size_id: number; model_id: number; expected_pcs: number; actual_pcs: number }>;
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.model_id).toBe(model.id);
      expect(line.actual_pcs).toBe(line.expected_pcs);
      expect(lotBalance('cutting_line', line.id, 'CUT')).toBe(line.expected_pcs);
    }

    // there is no actuals endpoint any more
    const actuals = await request(ctx.app)
      .post(`/api/cutting/${res.body.id}/actuals`)
      .set('Cookie', operator)
      .send({ lines: [] });
    expect(actuals.status).toBe(404);
  });

  it('typing the same code again reuses the identity; a new code creates a new one', async () => {
    const purchaseId = await makePurchase();
    const res = await request(ctx.app)
      .post('/api/cutting')
      .set('Cookie', operator)
      .send({
        cutDate: '2026-07-03',
        rawLotType: 'purchase',
        rawLotId: purchaseId,
        notes: '',
        lines: [
          { sizeId: 1, code: '315', qtyPcs: 40, clothPerPcInchC: 1000, widthCount: 4 },
          { sizeId: 2, code: '410', qtyPcs: 40, clothPerPcInchC: 1000, widthCount: 4, imagePath: null },
        ],
      });
    expect(res.status).toBe(201);
    const count315 = (
      ctx.db.prepare("SELECT COUNT(*) AS n FROM models WHERE code = '315'").get() as { n: number }
    ).n;
    expect(count315).toBe(1); // reused, not duplicated
    expect(ctx.db.prepare("SELECT id FROM models WHERE code = '410'").get()).toBeTruthy();

    // codes appear in the shared picker
    const products = await request(ctx.app).get('/api/products').set('Cookie', owner);
    const codes = (products.body.items as Array<{ code: string }>).map((p) => p.code);
    expect(codes).toContain('315');
    expect(codes).toContain('410');
    expect(codes).not.toContain('RAW-CLOTH');
  });

  it('rejects over-consumption, duplicate sizes, unknown lots and bad codes', async () => {
    const purchaseId = await makePurchase(36000); // only 10 yd

    const tooMuch = await request(ctx.app)
      .post('/api/cutting')
      .set('Cookie', operator)
      .send({
        cutDate: '2026-07-02',
        rawLotType: 'purchase',
        rawLotId: purchaseId,
        notes: '',
        lines: [{ sizeId: 1, code: '999', qtyPcs: 400, clothPerPcInchC: 1000, widthCount: 4 }],
      });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.error).toMatch(/only .* left/i);

    const dupSizes = await request(ctx.app)
      .post('/api/cutting')
      .set('Cookie', operator)
      .send({
        cutDate: '2026-07-02',
        rawLotType: 'purchase',
        rawLotId: purchaseId,
        notes: '',
        lines: [
          { sizeId: 1, code: '1', qtyPcs: 4, clothPerPcInchC: 1000, widthCount: 4 },
          { sizeId: 1, code: '1', qtyPcs: 4, clothPerPcInchC: 1000, widthCount: 4 },
        ],
      });
    expect(dupSizes.status).toBe(400);

    const unknownLot = await request(ctx.app)
      .post('/api/cutting')
      .set('Cookie', operator)
      .send({
        cutDate: '2026-07-02',
        rawLotType: 'purchase',
        rawLotId: 9999,
        notes: '',
        lines: [{ sizeId: 1, code: '1', qtyPcs: 4, clothPerPcInchC: 1000, widthCount: 4 }],
      });
    expect(unknownLot.status).toBe(400);

    const badCode = await request(ctx.app)
      .post('/api/cutting')
      .set('Cookie', operator)
      .send({
        cutDate: '2026-07-02',
        rawLotType: 'purchase',
        rawLotId: purchaseId,
        notes: '',
        lines: [{ sizeId: 1, code: '!!bad!!', qtyPcs: 4, clothPerPcInchC: 1000, widthCount: 4 }],
      });
    expect(badCode.status).toBe(400);

    // the failed attempts consumed nothing
    expect(lotBalance('purchase', purchaseId)).toBe(36000);
  });

  it('edit reworks the whole entry atomically and keeps the doc number', async () => {
    const purchaseId = await makePurchase();
    const created = await request(ctx.app)
      .post('/api/cutting')
      .set('Cookie', operator)
      .send({
        cutDate: '2026-07-04',
        rawLotType: 'purchase',
        rawLotId: purchaseId,
        notes: '',
        lines: [{ sizeId: 1, code: '520', qtyPcs: 120, clothPerPcInchC: 1000, widthCount: 4 }],
      });
    expect(created.status).toBe(201);
    const before = lotBalance('purchase', purchaseId);

    const edit = await request(ctx.app)
      .put(`/api/cutting/${created.body.id}`)
      .set('Cookie', operator)
      .send({
        cutDate: '2026-07-05',
        rawLotType: 'purchase',
        rawLotId: purchaseId,
        notes: 'replanned',
        lines: [
          { sizeId: 1, code: '520', qtyPcs: 60, clothPerPcInchC: 1000, widthCount: 4 },
          { sizeId: 2, code: '521', qtyPcs: 40, clothPerPcInchC: 1200, widthCount: 4 },
        ],
      });
    expect(edit.status).toBe(200);

    // cloth restored then re-consumed with the NEW geometry
    const newConsumption = clothRequiredInchC(60, 1000, 4) + clothRequiredInchC(40, 1200, 4);
    const oldConsumption = clothRequiredInchC(120, 1000, 4);
    expect(lotBalance('purchase', purchaseId)).toBe(before + oldConsumption - newConsumption);

    // doc number unchanged; lines replaced; new code created
    const row = ctx.db
      .prepare('SELECT doc_no FROM cutting_batches WHERE id = ?')
      .get(created.body.id) as { doc_no: string };
    expect(row.doc_no).toBe(created.body.docNo);
    const lines = ctx.db
      .prepare('SELECT size_id, expected_pcs FROM cutting_lines WHERE cutting_batch_id = ? ORDER BY size_id')
      .all(created.body.id) as Array<{ size_id: number; expected_pcs: number }>;
    expect(lines).toEqual([
      { size_id: 1, expected_pcs: 60 },
      { size_id: 2, expected_pcs: 40 },
    ]);

    // an edit that would overdraw is refused atomically — nothing changes
    const tooBig = await request(ctx.app)
      .put(`/api/cutting/${created.body.id}`)
      .set('Cookie', operator)
      .send({
        cutDate: '2026-07-05',
        rawLotType: 'purchase',
        rawLotId: purchaseId,
        notes: '',
        lines: [{ sizeId: 1, code: '520', qtyPcs: 99999, clothPerPcInchC: 1000, widthCount: 1 }],
      });
    expect(tooBig.status).toBe(409);
    expect(lotBalance('purchase', purchaseId)).toBe(before + oldConsumption - newConsumption);
  });

  it('delete restores the cloth and removes the pieces (soft void)', async () => {
    const purchaseId = await makePurchase();
    const created = await request(ctx.app)
      .post('/api/cutting')
      .set('Cookie', operator)
      .send({
        cutDate: '2026-07-06',
        rawLotType: 'purchase',
        rawLotId: purchaseId,
        notes: '',
        lines: [{ sizeId: 1, code: '520', qtyPcs: 40, clothPerPcInchC: 1000, widthCount: 4 }],
      });
    const before = lotBalance('purchase', purchaseId);

    const del = await request(ctx.app)
      .delete(`/api/cutting/${created.body.id}`)
      .set('Cookie', operator);
    expect(del.status).toBe(200);

    expect(lotBalance('purchase', purchaseId)).toBe(before + clothRequiredInchC(40, 1000, 4));
    const row = ctx.db
      .prepare('SELECT voided_at, void_reason FROM cutting_batches WHERE id = ?')
      .get(created.body.id) as { voided_at: string | null; void_reason: string };
    expect(row.voided_at).not.toBeNull(); // soft delete — history kept
    expect(row.void_reason).toMatch(/deleted/);
  });

  it('edit and delete are blocked once pieces moved downstream; admin void too', async () => {
    const purchaseId = await makePurchase();
    const created = await request(ctx.app)
      .post('/api/cutting')
      .set('Cookie', operator)
      .send({
        cutDate: '2026-07-07',
        rawLotType: 'purchase',
        rawLotId: purchaseId,
        notes: '',
        lines: [{ sizeId: 1, code: '620', qtyPcs: 48, clothPerPcInchC: 1000, widthCount: 4 }],
      });
    const modelId = (ctx.db.prepare("SELECT id FROM models WHERE code='620'").get() as { id: number }).id;

    // issue some of the pieces to a contractor
    const job = await request(ctx.app)
      .post('/api/jobs')
      .set('Cookie', operator)
      .send({
        issueDate: '2026-07-08',
        contractorId: 1,
        notes: '',
        lines: [{ modelId, colorId: 1, sizeId: 1, qtyIssuedPcs: 12, unitEntered: 'pieces', ratePaisePerDozen: 3000 }],
      });
    expect(job.status).toBe(201);

    const edit = await request(ctx.app)
      .put(`/api/cutting/${created.body.id}`)
      .set('Cookie', operator)
      .send({
        cutDate: '2026-07-07',
        rawLotType: 'purchase',
        rawLotId: purchaseId,
        notes: '',
        lines: [{ sizeId: 1, code: '620', qtyPcs: 48, clothPerPcInchC: 1000, widthCount: 4 }],
      });
    expect(edit.status).toBe(409);
    expect(edit.body.error).toMatch(/issued to a contractor/i);

    const del = await request(ctx.app).delete(`/api/cutting/${created.body.id}`).set('Cookie', operator);
    expect(del.status).toBe(409);

    const adminVoid = await request(ctx.app)
      .post(`/api/cutting/${created.body.id}/void`)
      .set('Cookie', admin)
      .send({ reason: 'trying anyway' });
    expect(adminVoid.status).toBe(409);
  });

  it('cuts from an opening-balance raw lot too', async () => {
    const opening = await request(ctx.app)
      .post('/api/opening-balances')
      .set('Cookie', admin)
      .send({ balanceDate: '2026-07-01', stage: 'RAW', colorId: 1, qty: 72000, widthInchC: 4000, note: '' });
    expect(opening.status).toBe(201);

    const res = await request(ctx.app)
      .post('/api/cutting')
      .set('Cookie', operator)
      .send({
        cutDate: '2026-07-02',
        rawLotType: 'opening',
        rawLotId: opening.body.id,
        notes: '',
        lines: [{ sizeId: 1, code: 'OPN-1', qtyPcs: 40, clothPerPcInchC: 900, widthCount: 4 }],
      });
    expect(res.status).toBe(201);
    expect(lotBalance('opening', opening.body.id)).toBe(72000 - clothRequiredInchC(40, 900, 4));
  });

  it('owner cannot cut; operator cannot use the admin void', async () => {
    const purchaseId = await makePurchase();
    const asOwner = await request(ctx.app)
      .post('/api/cutting')
      .set('Cookie', owner)
      .send({
        cutDate: '2026-07-02',
        rawLotType: 'purchase',
        rawLotId: purchaseId,
        notes: '',
        lines: [{ sizeId: 1, code: '1', qtyPcs: 4, clothPerPcInchC: 1000, widthCount: 4 }],
      });
    expect(asOwner.status).toBe(403);

    const created = await request(ctx.app)
      .post('/api/cutting')
      .set('Cookie', operator)
      .send({
        cutDate: '2026-07-02',
        rawLotType: 'purchase',
        rawLotId: purchaseId,
        notes: '',
        lines: [{ sizeId: 1, code: '520', qtyPcs: 4, clothPerPcInchC: 1000, widthCount: 4 }],
      });
    const opVoid = await request(ctx.app)
      .post(`/api/cutting/${created.body.id}/void`)
      .set('Cookie', operator)
      .send({ reason: 'nope' });
    expect(opVoid.status).toBe(403);
  });
});
