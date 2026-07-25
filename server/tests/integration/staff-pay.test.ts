import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { loginAs, makeTestContext, type TestContext } from '../helpers';

/**
 * Checker/packer pay: the rate per dozen lives on the staff master, is snapshotted onto
 * each check/pack issue, earnings accrue from RESULTS, and dues (earned − paid) are
 * settled with dated partial payments — mirroring contractors.
 */
let ctx: TestContext;
let admin: string;
let operator: string;
let owner: string;
let checkId = 0;

beforeAll(async () => {
  ctx = await makeTestContext();
  admin = await loginAs(ctx.app, 'admin', 'Admin@123');
  operator = await loginAs(ctx.app, 'operator', 'Operator@123');
  owner = await loginAs(ctx.app, 'owner', 'Owner@123');
  ctx.db.exec(`
    INSERT INTO colors (id, name, created_by) VALUES (1, 'Black', 1);
    INSERT INTO sizes (id, code, sort_order, created_by) VALUES (1, 'HR', 1, 1);
    INSERT INTO vendors (id, name, created_by) VALUES (1, 'V1', 1);
    INSERT INTO contractors (id, name, default_rate_paise_per_dozen, created_by) VALUES (1, 'Meena', 3000, 1);
    INSERT INTO staff (id, name, role, default_rate_paise_per_dozen, image_path, created_by) VALUES
      (1, 'Pooja', 'both', 300, '/uploads/2026-07/qr-pooja0000.webp', 1),
      (2, 'Ravi', 'both', 250, NULL, 1);
  `);

  // chain: purchase → cut 120 → job → receive all → ready for checking
  const purchase = await request(ctx.app).post('/api/purchases').set('Cookie', operator).send({
    purchaseDate: '2026-07-01',
    receivedDate: '2026-07-01',
    vendorId: 1,
    colorId: 1,
    lenInchC: 180000,
    widthInchC: 4400,
    ratePaisePerYard: 4000,
    notes: '',
  });
  await request(ctx.app)
    .post('/api/cutting')
    .set('Cookie', operator)
    .send({
      cutDate: '2026-07-02',
      rawLotType: 'purchase',
      rawLotId: purchase.body.id,
      notes: '',
      lines: [{ sizeId: 1, code: 'M1', qtyPcs: 120, clothPerPcInchC: 1000, widthCount: 3 }],
    });
  const modelM1 = (ctx.db.prepare("SELECT id FROM models WHERE code = 'M1'").get() as { id: number }).id;
  const job = await request(ctx.app)
    .post('/api/jobs')
    .set('Cookie', operator)
    .send({
      issueDate: '2026-07-03',
      contractorId: 1,
      notes: '',
      lines: [{ modelId: modelM1, colorId: 1, sizeId: 1, qtyIssuedPcs: 120, unitEntered: 'dozens', ratePaisePerDozen: 3000 }],
    });
  const jobCardId = job.body.cards[0].id as number;
  const lineId = (
    ctx.db.prepare('SELECT id FROM job_card_lines WHERE job_card_id = ?').get(jobCardId) as { id: number }
  ).id;
  const receipt = await request(ctx.app)
    .post(`/api/jobs/${jobCardId}/receipts`)
    .set('Cookie', operator)
    .send({
      receiptDate: '2026-07-05',
      imagePath: '/uploads/2026-07/returned.webp',
      lines: [{ jobCardLineId: lineId, qtyPcs: 120, returnType: 'stitched' }],
    });
  const receiptLineId = (
    ctx.db.prepare('SELECT id FROM job_receipt_lines WHERE job_receipt_id = ?').get(receipt.body.id) as { id: number }
  ).id;
  const check = await request(ctx.app).post('/api/checking').set('Cookie', operator).send({
    issueDate: '2026-07-06',
    staffId: 1,
    lotType: 'receipt_line',
    lotId: receiptLineId,
    qtyPcs: 120,
    notes: '',
  });
  if (check.status !== 201) throw new Error(`fixture check failed: ${check.text}`);
  checkId = check.body.id as number;
}, 30_000);
afterAll(() => ctx.cleanup());

describe('rates on issues', () => {
  it("the checker's default rate is snapshotted when none is sent", () => {
    const row = ctx.db
      .prepare('SELECT rate_paise_per_dozen AS rate FROM check_issues WHERE id = ?')
      .get(checkId) as { rate: number };
    expect(row.rate).toBe(300); // Pooja's master rate
  });

  it('an explicit rate at issue overrides the default (pack allotment)', async () => {
    // 108 pass + 12 rejected → 108 packable
    const result = await request(ctx.app)
      .post(`/api/checking/${checkId}/results`)
      .set('Cookie', operator)
      .send({
        resultDate: '2026-07-07',
        qtyPassed: 108,
        rejections: [{ reason: 'stitching_issue', qtyPcs: 12 }],
        notes: '',
      });
    expect(result.status).toBe(201);

    const pack = await request(ctx.app)
      .post(`/api/checking/${checkId}/pack`)
      .set('Cookie', operator)
      .send({
        issueDate: '2026-07-08',
        staffId: 2,
        qtyPcs: 108,
        kind: 'pack',
        label: '',
        ratePaisePerDozen: 275, // negotiated for this work — not Ravi's usual 250
        notes: '',
      });
    expect(pack.status).toBe(201);
    const row = ctx.db
      .prepare('SELECT rate_paise_per_dozen AS rate FROM pack_issues WHERE id = ?')
      .get(pack.body.id) as { rate: number };
    expect(row.rate).toBe(275);

    await request(ctx.app)
      .post(`/api/packing/${pack.body.id}/results`)
      .set('Cookie', operator)
      .send({ resultDate: '2026-07-09', qtyPacked: 108, qtyShort: 0 });
  });
});

describe('staff dues', () => {
  it('earnings = results × the snapshotted rate; dues listed largest first with the QR', async () => {
    const res = await request(ctx.app).get('/api/staff/dues').set('Cookie', owner);
    expect(res.status).toBe(200);
    const pooja = (res.body.items as Array<Record<string, unknown>>).find((r) => r.name === 'Pooja')!;
    const ravi = (res.body.items as Array<Record<string, unknown>>).find((r) => r.name === 'Ravi')!;
    // Pooja checked all 120 pcs (passed AND rejected are work done) @ ₹3.00/dz
    expect(pooja.checkedPcs).toBe(120);
    expect(pooja.earnedPaise).toBe(Math.round((120 * 300) / 12)); // 3000
    expect(pooja.imagePath).toBe('/uploads/2026-07/qr-pooja0000.webp');
    // Ravi packed 108 pcs @ the overridden ₹2.75/dz
    expect(ravi.packedPcs).toBe(108);
    expect(ravi.earnedPaise).toBe(Math.round((108 * 275) / 12)); // 2475
    expect(res.body.totalDuesPaise).toBe(3000 + 2475);
  });

  it('a dated partial payment reduces dues; a second settles; settled staff drop out', async () => {
    const part = await request(ctx.app).post('/api/staff/payments').set('Cookie', operator).send({
      staffId: 1,
      paymentDate: '2026-07-10',
      amountPaise: 1000,
      mode: 'upi',
      reference: 'UPI-1',
      notes: 'part payment',
    });
    expect(part.status).toBe(201);
    expect(part.body.docNo).toBe('SPAY-0001');

    let dues = (await request(ctx.app).get('/api/staff/dues').set('Cookie', owner)).body;
    let pooja = (dues.items as Array<Record<string, unknown>>).find((r) => r.name === 'Pooja')!;
    expect(pooja.paidPaise).toBe(1000);
    expect(pooja.duesPaise).toBe(2000);
    expect(pooja.lastPaymentDate).toBe('2026-07-10');

    await request(ctx.app).post('/api/staff/payments').set('Cookie', operator).send({
      staffId: 1,
      paymentDate: '2026-07-12',
      amountPaise: 2000,
      mode: 'cash',
      reference: '',
      notes: '',
    });
    dues = (await request(ctx.app).get('/api/staff/dues').set('Cookie', owner)).body;
    expect((dues.items as Array<Record<string, unknown>>).some((r) => r.name === 'Pooja')).toBe(false);
    // but the analytics view still shows her, fully paid
    const analytics = (await request(ctx.app).get('/api/staff/analytics').set('Cookie', owner)).body;
    pooja = (analytics.items as Array<Record<string, unknown>>).find((r) => r.name === 'Pooja')!;
    expect(pooja.duesPaise).toBe(0);
  });

  it('voiding a payment brings the dues back (admin only)', async () => {
    const denied = await request(ctx.app)
      .post('/api/staff/payments/1/void')
      .set('Cookie', operator)
      .send({ reason: 'operator trying' });
    expect(denied.status).toBe(403);

    const voided = await request(ctx.app)
      .post('/api/staff/payments/1/void')
      .set('Cookie', admin)
      .send({ reason: 'wrong person selected' });
    expect(voided.status).toBe(200);
    const dues = (await request(ctx.app).get('/api/staff/dues').set('Cookie', owner)).body;
    const pooja = (dues.items as Array<Record<string, unknown>>).find((r) => r.name === 'Pooja')!;
    expect(pooja.duesPaise).toBe(1000); // the voided ₹10 is owed again
  });

  it('payments validate: unknown staff 400; anonymous 401', async () => {
    const unknown = await request(ctx.app).post('/api/staff/payments').set('Cookie', operator).send({
      staffId: 999,
      paymentDate: '2026-07-10',
      amountPaise: 100,
      mode: 'cash',
      reference: '',
      notes: '',
    });
    expect(unknown.status).toBe(400);
    expect((await request(ctx.app).get('/api/staff/dues')).status).toBe(401);
  });

  it('the staff-dues report carries the same numbers', async () => {
    const res = await request(ctx.app).get('/api/reports/staff-dues').set('Cookie', owner);
    expect(res.status).toBe(200);
    const pooja = (res.body.rows as Array<Record<string, unknown>>).find((r) => r.name === 'Pooja')!;
    expect(pooja.earnedPaise).toBe(3000);
    expect(pooja.duesPaise).toBe(1000);
  });
});
