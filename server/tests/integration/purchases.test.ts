import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import { loginAs, makeTestContext, type TestContext } from '../helpers';

let ctx: TestContext;
let admin: string;
let operator: string;
let owner: string;

// no model — cloth is bought as vendor + color; the model is decided at cutting
const PURCHASE = {
  purchaseDate: '2026-07-01',
  receivedDate: '2026-07-03',
  vendorId: 1,
  colorId: 1,
  qtyCm: 12550, // 125.50 m
  ratePaisePerMeter: 4550, // ₹45.50/m
  notes: 'first lot',
};

beforeAll(async () => {
  ctx = await makeTestContext();
  admin = await loginAs(ctx.app, 'admin', 'Admin@123');
  operator = await loginAs(ctx.app, 'operator', 'Operator@123');
  owner = await loginAs(ctx.app, 'owner', 'Owner@123');
  ctx.db.exec(`
    INSERT INTO models (id, code, name, created_by) VALUES (1, 'M1', 'Model 1', 1);
    INSERT INTO colors (id, name, created_by) VALUES (1, 'Black', 1);
    INSERT INTO sizes (id, code, created_by) VALUES (1, 'XS', 1);
    INSERT INTO vendors (id, name, created_by) VALUES (1, 'V1', 1);
    INSERT INTO contractors (id, name, created_by) VALUES (1, 'C1', 1);
    INSERT INTO vendors (id, name, is_active, created_by) VALUES (2, 'Inactive Vendor', 0, 1);
  `);
});
afterAll(() => ctx.cleanup());

describe('purchases', () => {
  it('operator creates a purchase; RAW stock increases; total computed server-side', async () => {
    const res = await request(ctx.app)
      .post('/api/purchases')
      .set('Cookie', operator)
      .send(PURCHASE);
    expect(res.status).toBe(201);
    expect(res.body.docNo).toBe('RM-0001');

    const row = ctx.db
      .prepare('SELECT total_paise FROM purchases WHERE id = ?')
      .get(res.body.id) as { total_paise: number };
    // 125.5 m × ₹45.50 = ₹5,710.25 = 571025 paise
    expect(row.total_paise).toBe(571025);

    const stock = await request(ctx.app).get('/api/stock/raw').set('Cookie', owner);
    expect(stock.status).toBe(200);
    expect(stock.body.lots).toHaveLength(1);
    expect(stock.body.lots[0].qtyCm).toBe(12550);
    expect(stock.body.lots[0].vendorName).toBe('V1');
  });

  it('rejects received-before-purchase dates and inactive/unknown masters', async () => {
    const badDates = await request(ctx.app)
      .post('/api/purchases')
      .set('Cookie', operator)
      .send({ ...PURCHASE, receivedDate: '2026-06-30' });
    expect(badDates.status).toBe(400);
    expect(badDates.body.error).toMatch(/received date/i);

    const inactiveVendor = await request(ctx.app)
      .post('/api/purchases')
      .set('Cookie', operator)
      .send({ ...PURCHASE, vendorId: 2 });
    expect(inactiveVendor.status).toBe(400);
    expect(inactiveVendor.body.error).toMatch(/deactivated/i);

    const unknownColor = await request(ctx.app)
      .post('/api/purchases')
      .set('Cookie', operator)
      .send({ ...PURCHASE, colorId: 999 });
    expect(unknownColor.status).toBe(400);

    const zeroQty = await request(ctx.app)
      .post('/api/purchases')
      .set('Cookie', operator)
      .send({ ...PURCHASE, qtyCm: 0 });
    expect(zeroQty.status).toBe(400);
  });

  it('idempotency key replays the original result instead of duplicating', async () => {
    const key = crypto.randomUUID();
    const first = await request(ctx.app)
      .post('/api/purchases')
      .set('Cookie', operator)
      .set('Idempotency-Key', key)
      .send(PURCHASE);
    expect(first.status).toBe(201);

    const replay = await request(ctx.app)
      .post('/api/purchases')
      .set('Cookie', operator)
      .set('Idempotency-Key', key)
      .send(PURCHASE);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.id).toBe(first.body.id);

    const count = (
      ctx.db.prepare('SELECT COUNT(*) AS n FROM purchases').get() as { n: number }
    ).n;
    expect(count).toBe(2); // first test's + this one — not three
  });

  it('owner cannot create; operator cannot void; admin void reverses stock', async () => {
    const asOwner = await request(ctx.app).post('/api/purchases').set('Cookie', owner).send(PURCHASE);
    expect(asOwner.status).toBe(403);

    const created = await request(ctx.app)
      .post('/api/purchases')
      .set('Cookie', operator)
      .send(PURCHASE);
    const id = created.body.id as number;

    const opVoid = await request(ctx.app)
      .post(`/api/purchases/${id}/void`)
      .set('Cookie', operator)
      .send({ reason: 'entered wrong' });
    expect(opVoid.status).toBe(403);

    const noReason = await request(ctx.app)
      .post(`/api/purchases/${id}/void`)
      .set('Cookie', admin)
      .send({ reason: '' });
    expect(noReason.status).toBe(400);

    const beforeQty = (
      ctx.db
        .prepare(
          "SELECT COALESCE(SUM(qty),0) AS q FROM stock_ledger WHERE stage='RAW' AND lot_type='purchase' AND lot_id=?",
        )
        .get(id) as { q: number }
    ).q;
    expect(beforeQty).toBe(PURCHASE.qtyCm);

    const voided = await request(ctx.app)
      .post(`/api/purchases/${id}/void`)
      .set('Cookie', admin)
      .send({ reason: 'entered wrong' });
    expect(voided.status).toBe(200);

    const afterQty = (
      ctx.db
        .prepare(
          "SELECT COALESCE(SUM(qty),0) AS q FROM stock_ledger WHERE stage='RAW' AND lot_type='purchase' AND lot_id=?",
        )
        .get(id) as { q: number }
    ).q;
    expect(afterQty).toBe(0);

    // voided rows leave the default list but stay retrievable
    const list = await request(ctx.app).get('/api/purchases').set('Cookie', operator);
    expect(list.body.items.some((p: { id: number }) => p.id === id)).toBe(false);
    const withVoided = await request(ctx.app)
      .get('/api/purchases?includeVoided=1')
      .set('Cookie', operator);
    expect(withVoided.body.items.some((p: { id: number }) => p.id === id)).toBe(true);

    const again = await request(ctx.app)
      .post(`/api/purchases/${id}/void`)
      .set('Cookie', admin)
      .send({ reason: 'twice' });
    expect(again.status).toBe(409);
  });

  it('void is blocked once the cloth has been consumed downstream', async () => {
    const created = await request(ctx.app)
      .post('/api/purchases')
      .set('Cookie', operator)
      .send(PURCHASE);
    const id = created.body.id as number;

    // simulate a cutting consumption directly through the ledger
    ctx.db
      .prepare(
        `INSERT INTO cutting_batches (doc_no, cut_date, raw_lot_type, raw_lot_id, model_id, color_id, meters_used_cm, status, created_by)
         VALUES ('CUT-TEST', '2026-07-04', 'purchase', ?, 1, 1, 500, 'planned', 1)`,
      )
      .run(id);
    ctx.db
      .prepare(
        `INSERT INTO stock_ledger (stage, model_id, color_id, size_id, lot_type, lot_id, qty, ref_type, ref_id, created_by)
         VALUES ('RAW', 1, 1, NULL, 'purchase', ?, -500, 'cutting_consume', 1, 1)`,
      )
      .run(id);

    const blocked = await request(ctx.app)
      .post(`/api/purchases/${id}/void`)
      .set('Cookie', admin)
      .send({ reason: 'should fail' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/CUT-TEST/);
  });

  it('edit changes financial fields only and recomputes the total', async () => {
    const created = await request(ctx.app)
      .post('/api/purchases')
      .set('Cookie', operator)
      .send(PURCHASE);
    const id = created.body.id as number;

    const edit = await request(ctx.app)
      .put(`/api/purchases/${id}`)
      .set('Cookie', operator)
      .send({ ratePaisePerMeter: 5000, notes: 'renegotiated', imagePath: null });
    expect(edit.status).toBe(200);

    const row = ctx.db
      .prepare('SELECT total_paise, qty_cm FROM purchases WHERE id = ?')
      .get(id) as { total_paise: number; qty_cm: number };
    expect(row.qty_cm).toBe(PURCHASE.qtyCm); // immutable
    expect(row.total_paise).toBe(Math.round((PURCHASE.qtyCm * 5000) / 100));

    // qty is not editable via the API at all
    const qtyAttempt = await request(ctx.app)
      .put(`/api/purchases/${id}`)
      .set('Cookie', operator)
      .send({ ratePaisePerMeter: 5000, notes: '', qtyCm: 99999 });
    expect(qtyAttempt.status).toBe(200); // extra key ignored by schema
    const rowAfter = ctx.db.prepare('SELECT qty_cm FROM purchases WHERE id = ?').get(id) as {
      qty_cm: number;
    };
    expect(rowAfter.qty_cm).toBe(PURCHASE.qtyCm);
  });
});

describe('opening balances', () => {
  it('admin posts opening stock into any stage; ledger reflects it', async () => {
    const raw = await request(ctx.app)
      .post('/api/opening-balances')
      .set('Cookie', admin)
      .send({ balanceDate: '2026-07-01', stage: 'RAW', colorId: 1, qty: 5000, note: 'register carry-over' });
    expect(raw.status).toBe(201);
    expect(raw.body.docNo).toMatch(/^OPB-/);

    const wip = await request(ctx.app)
      .post('/api/opening-balances')
      .set('Cookie', admin)
      .send({
        balanceDate: '2026-07-01',
        stage: 'WIP',
        modelId: 1,
        colorId: 1,
        sizeId: 1,
        contractorId: 1,
        qty: 240,
        note: 'with Meena',
      });
    expect(wip.status).toBe(201);

    const fg = await request(ctx.app)
      .post('/api/opening-balances')
      .set('Cookie', admin)
      .send({ balanceDate: '2026-07-01', stage: 'FG', modelId: 1, colorId: 1, sizeId: 1, qty: 600 });
    expect(fg.status).toBe(201);

    const wipStock = await request(ctx.app).get('/api/stock/WIP').set('Cookie', owner);
    expect(wipStock.body.items[0].qty).toBe(240);
    expect(wipStock.body.items[0].contractorName).toBe('C1');

    const summary = await request(ctx.app).get('/api/stock/summary').set('Cookie', owner);
    const fgRow = summary.body.stages.find((s: { stage: string }) => s.stage === 'FG');
    expect(fgRow.qty).toBe(600);
  });

  it('validates stage-specific requirements', async () => {
    const wipNoContractor = await request(ctx.app)
      .post('/api/opening-balances')
      .set('Cookie', admin)
      .send({ balanceDate: '2026-07-01', stage: 'WIP', modelId: 1, colorId: 1, sizeId: 1, qty: 10 });
    expect(wipNoContractor.status).toBe(400);
    expect(wipNoContractor.body.error).toMatch(/contractor/i);

    const cutNoSize = await request(ctx.app)
      .post('/api/opening-balances')
      .set('Cookie', admin)
      .send({ balanceDate: '2026-07-01', stage: 'CUT', modelId: 1, colorId: 1, qty: 10 });
    expect(cutNoSize.status).toBe(400);
  });

  it('is admin-only and voidable while unconsumed', async () => {
    const asOperator = await request(ctx.app)
      .post('/api/opening-balances')
      .set('Cookie', operator)
      .send({ balanceDate: '2026-07-01', stage: 'FG', modelId: 1, colorId: 1, sizeId: 1, qty: 5 });
    expect(asOperator.status).toBe(403);

    const created = await request(ctx.app)
      .post('/api/opening-balances')
      .set('Cookie', admin)
      .send({ balanceDate: '2026-07-01', stage: 'CUT', modelId: 1, colorId: 1, sizeId: 1, qty: 60 });
    const voided = await request(ctx.app)
      .post(`/api/opening-balances/${created.body.id}/void`)
      .set('Cookie', admin)
      .send({ reason: 'typo' });
    expect(voided.status).toBe(200);

    const cutStock = await request(ctx.app).get('/api/stock/CUT').set('Cookie', admin);
    expect(cutStock.body.items).toHaveLength(0);
  });
});
