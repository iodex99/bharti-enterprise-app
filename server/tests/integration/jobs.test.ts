import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { loginAs, makeTestContext, type TestContext } from '../helpers';

const PHOTO = '/uploads/2026-07/aaaaaaaaaaaaaaaa.webp'; // receipts REQUIRE a photo (ADR-032)

/**
 * Module 5/6 flows. Fixture: 2 cutting batches yield XS=240pcs total (120 + 120)
 * so FIFO allocation across lots is exercised, plus S1=120pcs.
 */
let ctx: TestContext;
let admin: string;
let operator: string;
let owner: string;
let modelM1 = 0;

const wipBalance = (lineId: number) =>
  (
    ctx.db
      .prepare(
        "SELECT COALESCE(SUM(qty),0) AS q FROM stock_ledger WHERE stage='WIP' AND lot_type='job_line' AND lot_id=?",
      )
      .get(lineId) as { q: number }
  ).q;

const stageTotal = (stage: string) =>
  (
    ctx.db
      .prepare('SELECT COALESCE(SUM(qty),0) AS q FROM stock_ledger WHERE stage = ?')
      .get(stage) as { q: number }
  ).q;

beforeAll(async () => {
  ctx = await makeTestContext();
  admin = await loginAs(ctx.app, 'admin', 'Admin@123');
  operator = await loginAs(ctx.app, 'operator', 'Operator@123');
  owner = await loginAs(ctx.app, 'owner', 'Owner@123');
  ctx.db.exec(`
    INSERT INTO colors (id, name, created_by) VALUES (1, 'Black', 1);
    INSERT INTO sizes (id, code, sort_order, created_by) VALUES (1, 'XS', 1, 1), (2, 'S1', 2, 1);
    INSERT INTO vendors (id, name, created_by) VALUES (1, 'V1', 1);
    INSERT INTO contractors (id, name, default_rate_paise_per_dozen, created_by)
      VALUES (1, 'Meena', 3000, 1), (2, 'Rafiq', 2800, 1);
  `);
  // purchase + two cutting batches (code typed at cutting; the plan IS the cutting)
  const purchase = await request(ctx.app).post('/api/purchases').set('Cookie', operator).send({
    purchaseDate: '2026-07-01',
    receivedDate: '2026-07-01',
    vendorId: 1,
    colorId: 1,
    lenInchC: 720000, // 200 yd
    widthInchC: 4400,
    ratePaisePerYard: 4000,
    notes: '',
  });
  for (const _ of [1, 2]) {
    const cutRes = await request(ctx.app)
      .post('/api/cutting')
      .set('Cookie', operator)
      .send({
        cutDate: '2026-07-02',
        rawLotType: 'purchase',
        rawLotId: purchase.body.id,
        notes: '',
        lines: [
          { sizeId: 1, code: 'M1', qtyPcs: 120, clothPerPcInchC: 1000, widthCount: 3 },
          { sizeId: 2, code: 'M1', qtyPcs: 60, clothPerPcInchC: 1200, widthCount: 2 },
        ],
      });
    if (cutRes.status !== 201) throw new Error(`fixture cutting failed: ${cutRes.text}`);
  }
  modelM1 = (ctx.db.prepare("SELECT id FROM models WHERE code = 'M1'").get() as { id: number }).id;
});
afterAll(() => ctx.cleanup());

describe('job cards', () => {
  let jobId: number;
  let lineXS: { id: number; qtyIssuedPcs: number };

  it('issues cut stock to a contractor with FIFO allocation across cutting batches', async () => {
    const res = await request(ctx.app)
      .post('/api/jobs')
      .set('Cookie', operator)
      .send({
        issueDate: '2026-07-03',
        contractorId: 1,
        notes: '',
        lines: [
          { modelId: modelM1, colorId: 1, sizeId: 1, qtyIssuedPcs: 180, unitEntered: 'dozens', ratePaisePerDozen: 3000 },
        ], // 15 dz spans both batches
      });
    expect(res.status).toBe(201);
    expect(res.body.cards).toHaveLength(1);
    expect(res.body.cards[0].docNo).toBe('JOB-0001');
    jobId = res.body.cards[0].id as number;

    const list = await request(ctx.app).get('/api/jobs').set('Cookie', owner);
    const job = list.body.items.find((j: { id: number }) => j.id === jobId);
    expect(job.status).toBe('open');
    expect(job.issuedPcs).toBe(180);
    lineXS = job.lines[0];

    // allocations: 120 from batch 1 line + 60 from batch 2 line
    const allocs = ctx.db
      .prepare('SELECT qty_pcs FROM job_allocations WHERE job_card_line_id = ? ORDER BY id')
      .all(lineXS.id) as Array<{ qty_pcs: number }>;
    expect(allocs.map((a) => a.qty_pcs)).toEqual([120, 60]);
    expect(wipBalance(lineXS.id)).toBe(180);
    // CUT for XS is now 240-180=60
    const cut = await request(ctx.app).get('/api/stock/CUT').set('Cookie', owner);
    const xs = cut.body.items.find((r: { sizeCode: string }) => r.sizeCode === 'XS');
    expect(xs.qty).toBe(60);
  });

  it('rejects issuing more than available cut stock', async () => {
    const res = await request(ctx.app)
      .post('/api/jobs')
      .set('Cookie', operator)
      .send({
        issueDate: '2026-07-03',
        contractorId: 1,
        lines: [{ modelId: modelM1, colorId: 1, sizeId: 1, qtyIssuedPcs: 100, unitEntered: 'pieces', ratePaisePerDozen: 3000 }],
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/available 60/);
  });

  it('partial receipts 15dz = 2+3+5+5dz; status transitions to completed on exact match', async () => {
    const receive = (dz: number) =>
      request(ctx.app)
        .post(`/api/jobs/${jobId}/receipts`)
        .set('Cookie', operator)
        .send({
          receiptDate: '2026-07-05',
          imagePath: PHOTO,
          lines: [{ jobCardLineId: lineXS.id, qtyPcs: dz * 12, returnType: 'stitched' }],
        });

    const r1 = await receive(2);
    expect(r1.status).toBe(201);
    expect(r1.body.status).toBe('partially_received');
    const r2 = await receive(3);
    expect(r2.body.status).toBe('partially_received');
    const r3 = await receive(5);
    expect(r3.body.status).toBe('partially_received');
    expect(wipBalance(lineXS.id)).toBe(60); // 5 dz still out

    const r4 = await receive(5);
    expect(r4.body.status).toBe('completed'); // auto-complete on exact match
    expect(wipBalance(lineXS.id)).toBe(0);
    expect(stageTotal('CHECKING')).toBe(180);

    const list = await request(ctx.app).get('/api/jobs').set('Cookie', owner);
    const job = list.body.items.find((j: { id: number }) => j.id === jobId);
    expect(job.status).toBe('completed');
    expect(job.jobCostPaise).toBe(Math.round((180 * 3000) / 12)); // 15dz × ₹30
  });

  it('excess receipt needs a reason, creates stock + discrepancy', async () => {
    const job = await request(ctx.app)
      .post('/api/jobs')
      .set('Cookie', operator)
      .send({
        issueDate: '2026-07-06',
        contractorId: 2,
        lines: [{ modelId: modelM1, colorId: 1, sizeId: 1, qtyIssuedPcs: 24, unitEntered: 'dozens', ratePaisePerDozen: 2800 }],
      });
    const lineId = (
      ctx.db
        .prepare('SELECT id FROM job_card_lines WHERE job_card_id = ?')
        .get(job.body.cards[0].id) as { id: number }
    ).id;

    const noReason = await request(ctx.app)
      .post(`/api/jobs/${job.body.cards[0].id}/receipts`)
      .set('Cookie', operator)
      .send({
        receiptDate: '2026-07-08',
        imagePath: PHOTO,
        lines: [{ jobCardLineId: lineId, qtyPcs: 30, returnType: 'stitched' }],
      });
    expect(noReason.status).toBe(409);
    expect(noReason.body.error).toMatch(/discrepancy reason/i);

    const before = stageTotal('CHECKING');
    const withReason = await request(ctx.app)
      .post(`/api/jobs/${job.body.cards[0].id}/receipts`)
      .set('Cookie', operator)
      .send({
        receiptDate: '2026-07-08',
        imagePath: PHOTO,
        lines: [
          {
            jobCardLineId: lineId,
            qtyPcs: 30,
            returnType: 'stitched',
            discrepancyReason: 'other',
            discrepancyNote: 'contractor added extras from own stock',
          },
        ],
      });
    expect(withReason.status).toBe(201);
    expect(withReason.body.status).toBe('completed'); // over-settled counts as settled
    expect(stageTotal('CHECKING')).toBe(before + 30);
    expect(wipBalance(lineId)).toBe(0);

    const excessRow = ctx.db
      .prepare("SELECT qty_pcs FROM discrepancies WHERE ref_type='job_card_line' AND ref_id=?")
      .get(lineId) as { qty_pcs: number };
    expect(excessRow.qty_pcs).toBe(6); // 30 received vs 24 issued
  });

  it('unstitched return goes back to CUT and reduces settlement need', async () => {
    const job = await request(ctx.app)
      .post('/api/jobs')
      .set('Cookie', operator)
      .send({
        issueDate: '2026-07-07',
        contractorId: 1,
        lines: [{ modelId: modelM1, colorId: 1, sizeId: 2, qtyIssuedPcs: 60, unitEntered: 'dozens', ratePaisePerDozen: 3000 }], // 5 dz S1
      });
    const lineId = (
      ctx.db
        .prepare('SELECT id FROM job_card_lines WHERE job_card_id = ?')
        .get(job.body.cards[0].id) as { id: number }
    ).id;
    const cutBefore = (
      (await request(ctx.app).get('/api/stock/CUT').set('Cookie', owner)).body.items.find(
        (r: { sizeCode: string }) => r.sizeCode === 'S1',
      ) ?? { qty: 0 }
    ).qty;

    // 3 dz stitched + 2 dz returned unstitched = fully settled
    const receipt = await request(ctx.app)
      .post(`/api/jobs/${job.body.cards[0].id}/receipts`)
      .set('Cookie', operator)
      .send({
        receiptDate: '2026-07-09',
        imagePath: PHOTO,
        lines: [
          { jobCardLineId: lineId, qtyPcs: 36, returnType: 'stitched' },
          { jobCardLineId: lineId, qtyPcs: 24, returnType: 'unstitched_return' },
        ],
      });
    expect(receipt.status).toBe(201);
    expect(receipt.body.status).toBe('completed');
    expect(wipBalance(lineId)).toBe(0);

    const cutAfter = (
      (await request(ctx.app).get('/api/stock/CUT').set('Cookie', owner)).body.items.find(
        (r: { sizeCode: string }) => r.sizeCode === 'S1',
      ) ?? { qty: 0 }
    ).qty;
    expect(cutAfter).toBe(cutBefore + 24);

    // job cost counts only stitched pieces: 3dz × ₹30 = ₹90
    const list = await request(ctx.app).get('/api/jobs').set('Cookie', owner);
    const j = list.body.items.find((x: { id: number }) => x.id === job.body.cards[0].id);
    expect(j.jobCostPaise).toBe(9000);
  });

  it('shortage: operator cannot close; admin close writes off WIP with discrepancy', async () => {
    const job = await request(ctx.app)
      .post('/api/jobs')
      .set('Cookie', operator)
      .send({
        issueDate: '2026-07-08',
        contractorId: 2,
        lines: [{ modelId: modelM1, colorId: 1, sizeId: 2, qtyIssuedPcs: 36, unitEntered: 'dozens', ratePaisePerDozen: 2800 }],
      });
    const lineId = (
      ctx.db
        .prepare('SELECT id FROM job_card_lines WHERE job_card_id = ?')
        .get(job.body.cards[0].id) as { id: number }
    ).id;
    await request(ctx.app)
      .post(`/api/jobs/${job.body.cards[0].id}/receipts`)
      .set('Cookie', operator)
      .send({
        receiptDate: '2026-07-10',
        imagePath: PHOTO,
        lines: [{ jobCardLineId: lineId, qtyPcs: 30, returnType: 'stitched' }],
      });

    const opClose = await request(ctx.app)
      .post(`/api/jobs/${job.body.cards[0].id}/close`)
      .set('Cookie', operator)
      .send({ reason: 'missing_pieces', note: 'contractor lost them' });
    expect(opClose.status).toBe(403);

    const adminClose = await request(ctx.app)
      .post(`/api/jobs/${job.body.cards[0].id}/close`)
      .set('Cookie', admin)
      .send({ reason: 'missing_pieces', note: 'contractor lost 6 pcs' });
    expect(adminClose.status).toBe(200);
    expect(adminClose.body.shortagePcs).toBe(6);
    expect(wipBalance(lineId)).toBe(0);

    const list = await request(ctx.app).get('/api/jobs').set('Cookie', owner);
    const j = list.body.items.find((x: { id: number }) => x.id === job.body.cards[0].id);
    expect(j.status).toBe('closed_with_discrepancy');

    // no more receipts after closing
    const late = await request(ctx.app)
      .post(`/api/jobs/${job.body.cards[0].id}/receipts`)
      .set('Cookie', operator)
      .send({
        receiptDate: '2026-07-11',
        imagePath: PHOTO,
        lines: [{ jobCardLineId: lineId, qtyPcs: 6, returnType: 'stitched' }],
      });
    expect(late.status).toBe(409);
  });

  it('void restores CUT stock but only for unstarted jobs', async () => {
    const cutBefore = stageTotal('CUT');
    const job = await request(ctx.app)
      .post('/api/jobs')
      .set('Cookie', operator)
      .send({
        issueDate: '2026-07-09',
        contractorId: 1,
        lines: [{ modelId: modelM1, colorId: 1, sizeId: 1, qtyIssuedPcs: 12, unitEntered: 'dozens', ratePaisePerDozen: 3000 }],
      });
    expect(stageTotal('CUT')).toBe(cutBefore - 12);

    const voided = await request(ctx.app)
      .post(`/api/jobs/${job.body.cards[0].id}/void`)
      .set('Cookie', admin)
      .send({ reason: 'wrong contractor picked' });
    expect(voided.status).toBe(200);
    expect(stageTotal('CUT')).toBe(cutBefore);

    // jobId (with receipts) cannot be voided
    const blocked = await request(ctx.app)
      .post(`/api/jobs/${jobId}/void`)
      .set('Cookie', admin)
      .send({ reason: 'trying to void a started job' });
    expect(blocked.status).toBe(409);
  });
});

describe('contractor analytics & payments', () => {
  it('aggregates per-contractor performance and dues', async () => {
    const res = await request(ctx.app).get('/api/contractors/analytics').set('Cookie', owner);
    expect(res.status).toBe(200);
    const meena = res.body.items.find((c: { name: string }) => c.name === 'Meena');
    const rafiq = res.body.items.find((c: { name: string }) => c.name === 'Rafiq');

    // Meena: JOB-0001 fully received (180 stitched @3000/dz) + S1 job (36 stitched @3000/dz)
    expect(meena.receivedPcs).toBe(216);
    expect(meena.unstitchedReturnedPcs).toBe(24);
    expect(meena.jobWorkCostPaise).toBe(Math.round((216 * 3000) / 12));
    expect(meena.shortagePcs).toBe(0);

    // Rafiq: excess 6 + shortage 6
    expect(rafiq.excessPcs).toBe(6);
    expect(rafiq.shortagePcs).toBe(6);
    expect(rafiq.discrepancyJobs).toBe(1);
    expect(rafiq.duesPaise).toBe(rafiq.jobWorkCostPaise); // nothing paid yet
  });

  it('payments reduce dues; voiding a payment restores them', async () => {
    const payment = await request(ctx.app)
      .post('/api/contractors/payments')
      .set('Cookie', operator)
      .send({
        contractorId: 1,
        paymentDate: '2026-07-10',
        amountPaise: 20000,
        mode: 'upi',
        reference: 'UPI-123',
        notes: '',
      });
    expect(payment.status).toBe(201);
    expect(payment.body.docNo).toMatch(/^PAY-/);

    let analytics = await request(ctx.app).get('/api/contractors/analytics').set('Cookie', owner);
    let meena = analytics.body.items.find((c: { name: string }) => c.name === 'Meena');
    expect(meena.paidPaise).toBe(20000);
    expect(meena.duesPaise).toBe(meena.jobWorkCostPaise - 20000);

    const voidRes = await request(ctx.app)
      .post(`/api/contractors/payments/${payment.body.id}/void`)
      .set('Cookie', admin)
      .send({ reason: 'entered twice' });
    expect(voidRes.status).toBe(200);

    analytics = await request(ctx.app).get('/api/contractors/analytics').set('Cookie', owner);
    meena = analytics.body.items.find((c: { name: string }) => c.name === 'Meena');
    expect(meena.paidPaise).toBe(0);
  });

  it('owner cannot record payments', async () => {
    const res = await request(ctx.app)
      .post('/api/contractors/payments')
      .set('Cookie', owner)
      .send({ contractorId: 1, paymentDate: '2026-07-10', amountPaise: 100, mode: 'cash' });
    expect(res.status).toBe(403);
  });
});
