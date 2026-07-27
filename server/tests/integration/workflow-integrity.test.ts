import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { loginAs, makeTestContext, type TestContext } from '../helpers';

/**
 * Edge cases found by auditing the whole workflow. Each test here pins one defect that
 * was real: money that could never be settled, ledger refusals reported as malformed
 * requests, a bundle that could get stuck, discrepancies blaming the wrong fault,
 * allocations outliving their document, and a settled job card that still took goods.
 */
let ctx: TestContext;
let admin: string;
let operator: string;
let owner: string;
let modelId = 0;

const post = (url: string, cookie: string, body?: unknown, officeId?: number) => {
  let r = request(ctx.app).post(url).set('Cookie', cookie);
  if (officeId) r = r.set('X-Office-Id', String(officeId));
  return body === undefined ? r : r.send(body as object);
};

/** purchase -> cut -> job -> receipt: leaves goods waiting for a checker. */
async function freshChain(code: string, qtyPcs = 120) {
  const purchase = await post('/api/purchases', operator, {
    purchaseDate: '2026-07-01',
    receivedDate: '2026-07-01',
    vendorId: 1,
    colorId: 1,
    lenInchC: 360000,
    widthInchC: 4400,
    ratePaisePerYard: 4000,
    notes: '',
  });
  await post('/api/cutting', operator, {
    cutDate: '2026-07-02',
    rawLotType: 'purchase',
    rawLotId: purchase.body.id,
    notes: '',
    lines: [{ sizeId: 1, code, qtyPcs, clothPerPcInchC: 1000, widthCount: 3 }],
  });
  modelId = (ctx.db.prepare('SELECT id FROM models WHERE code = ?').get(code) as { id: number }).id;
  const job = await post('/api/jobs', operator, {
    issueDate: '2026-07-03',
    contractorId: 1,
    notes: '',
    lines: [{ modelId, colorId: 1, sizeId: 1, qtyIssuedPcs: qtyPcs, unitEntered: 'pieces', ratePaisePerDozen: 3000 }],
  });
  const jobId = job.body.cards[0].id as number;
  const lineId = (
    ctx.db.prepare('SELECT id FROM job_card_lines WHERE job_card_id = ?').get(jobId) as { id: number }
  ).id;
  return { purchaseId: purchase.body.id as number, jobId, lineId };
}

async function receive(jobId: number, lineId: number, qtyPcs: number, date = '2026-07-05') {
  const res = await post(`/api/jobs/${jobId}/receipts`, operator, {
    receiptDate: date,
    imagePath: '/uploads/2026-07/r.webp',
    lines: [{ jobCardLineId: lineId, qtyPcs, returnType: 'stitched' }],
  });
  return res;
}

const lastReceiptLine = (jobId: number) =>
  (
    ctx.db
      .prepare(
        `SELECT rl.id FROM job_receipt_lines rl JOIN job_receipts r ON r.id = rl.job_receipt_id
         WHERE r.job_card_id = ? ORDER BY rl.id DESC LIMIT 1`,
      )
      .get(jobId) as { id: number }
  ).id;

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
    INSERT INTO staff (id, name, role, default_rate_paise_per_dozen, created_by) VALUES
      (1, 'Pooja', 'both', 300, 1), (2, 'Ravi', 'both', 300, 1);
  `);
}, 30_000);
afterAll(() => ctx.cleanup());

describe('a refused ledger move explains itself', () => {
  it('voiding a bundle whose pieces have moved on says so, instead of "Invalid request body"', async () => {
    const { jobId, lineId } = await freshChain('ERR-1');
    await receive(jobId, lineId, 120);
    const check = await post('/api/checking', operator, {
      issueDate: '2026-07-06',
      staffId: 1,
      lotType: 'receipt_line',
      lotId: lastReceiptLine(jobId),
      qtyPcs: 120,
      notes: '',
    });
    await post(`/api/checking/${check.body.id}/results`, operator, {
      resultDate: '2026-07-07',
      qtyPassed: 120,
      rejections: [],
      notes: '',
    });
    // keep all 120 aside as a bundle, then draw 60 of them out to another packer
    const bundle = await post(`/api/checking/${check.body.id}/pack`, operator, {
      issueDate: '2026-07-08',
      staffId: 1,
      qtyPcs: 120,
      kind: 'bundle',
      label: 'Reserve',
      notes: '',
    });
    const drawn = await post('/api/packing', operator, {
      issueDate: '2026-07-09',
      staffId: 2,
      lotType: 'pack_issue',
      lotId: bundle.body.id,
      qtyPcs: 60,
      kind: 'pack',
      label: '',
      notes: '',
    });
    expect(drawn.status).toBe(201);

    const voided = await post(`/api/packing/${bundle.body.id}/void`, admin, { reason: 'changed my mind' });
    expect(voided.status).toBeGreaterThanOrEqual(400);
    expect(voided.body.error).not.toMatch(/invalid request body/i);
    expect(voided.body.error).toMatch(/stock|pcs|available|enough/i); // the real reason
  });
});

describe('payments can only be booked where the work happened', () => {
  it('a contractor payment in an office with no job work is refused, not silently lost', async () => {
    const office = await post('/api/offices', admin, { code: 'BR', name: 'Branch Office' });
    const BR = office.body.id as number;

    const wrongOffice = await post(
      '/api/contractors/payments',
      admin,
      { contractorId: 1, paymentDate: '2026-07-10', amountPaise: 5000, mode: 'cash', reference: '', notes: '' },
      BR,
    );
    expect(wrongOffice.status).toBe(400);
    expect(wrongOffice.body.error).toMatch(/no job work in Branch Office/i);

    // the same payment lands fine in the office where the work was issued
    const rightOffice = await post(
      '/api/contractors/payments',
      admin,
      { contractorId: 1, paymentDate: '2026-07-10', amountPaise: 5000, mode: 'cash', reference: '', notes: '' },
      1,
    );
    expect(rightOffice.status).toBe(201);
  });

  it('a checker payment in an office where they never worked is refused', async () => {
    const BR = (ctx.db.prepare("SELECT id FROM offices WHERE code = 'BR'").get() as { id: number }).id;
    const res = await post(
      '/api/staff/payments',
      admin,
      { staffId: 1, paymentDate: '2026-07-10', amountPaise: 500, mode: 'cash', reference: '', notes: '' },
      BR,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/has not checked or packed anything in Branch Office/i);
  });
});

describe('a bundle stays usable after a draw from it is voided', () => {
  it('pieces flowing back reopen the bundle so they can be packed again', async () => {
    const { jobId, lineId } = await freshChain('BND-1');
    await receive(jobId, lineId, 120);
    const check = await post('/api/checking', operator, {
      issueDate: '2026-07-06',
      staffId: 1,
      lotType: 'receipt_line',
      lotId: lastReceiptLine(jobId),
      qtyPcs: 120,
      notes: '',
    });
    await post(`/api/checking/${check.body.id}/results`, operator, {
      resultDate: '2026-07-07',
      qtyPassed: 120,
      rejections: [],
      notes: '',
    });
    const bundle = await post(`/api/checking/${check.body.id}/pack`, operator, {
      issueDate: '2026-07-08',
      staffId: 1,
      qtyPcs: 120,
      kind: 'bundle',
      label: 'Festival reserve',
      notes: '',
    });
    // draw 60 to Ravi, then pack the other 60 from the bundle -> the bundle empties
    const drawn = await post('/api/packing', operator, {
      issueDate: '2026-07-09',
      staffId: 2,
      lotType: 'pack_issue',
      lotId: bundle.body.id,
      qtyPcs: 60,
      kind: 'pack',
      label: '',
      notes: '',
    });
    await post(`/api/packing/${bundle.body.id}/results`, operator, {
      resultDate: '2026-07-10',
      qtyPacked: 60,
      qtyShort: 0,
    });
    expect(
      (ctx.db.prepare('SELECT status FROM pack_issues WHERE id = ?').get(bundle.body.id) as { status: string }).status,
    ).toBe('completed');

    // Ravi's draw is voided: his 60 pcs go back onto the bundle
    const voided = await post(`/api/packing/${drawn.body.id}/void`, admin, { reason: 'Ravi never took them' });
    expect(voided.status).toBe(200);

    // the bundle holds stock again, so it must be open for packing again
    const row = ctx.db
      .prepare('SELECT status FROM pack_issues WHERE id = ?')
      .get(bundle.body.id) as { status: string };
    expect(row.status).toBe('open');
    const packAgain = await post(`/api/packing/${bundle.body.id}/results`, operator, {
      resultDate: '2026-07-11',
      qtyPacked: 60,
      qtyShort: 0,
    });
    expect(packAgain.status).toBe(201);
  });
});

describe('discrepancies name the fault that actually happened', () => {
  it('two rejection reasons produce two rows, each with its own quantity', async () => {
    const { jobId, lineId } = await freshChain('REJ-1');
    await receive(jobId, lineId, 120);
    const check = await post('/api/checking', operator, {
      issueDate: '2026-07-06',
      staffId: 1,
      lotType: 'receipt_line',
      lotId: lastReceiptLine(jobId),
      qtyPcs: 120,
      notes: '',
    });
    const before = (ctx.db.prepare('SELECT COUNT(*) AS n FROM discrepancies').get() as { n: number }).n;
    await post(`/api/checking/${check.body.id}/results`, operator, {
      resultDate: '2026-07-07',
      qtyPassed: 106,
      rejections: [
        { reason: 'damage', qtyPcs: 4 },
        { reason: 'color_defect', qtyPcs: 10 },
      ],
      notes: '',
    });
    const rows = ctx.db
      .prepare('SELECT reason, qty_pcs FROM discrepancies ORDER BY id DESC LIMIT 2')
      .all() as Array<{ reason: string; qty_pcs: number }>;
    expect((ctx.db.prepare('SELECT COUNT(*) AS n FROM discrepancies').get() as { n: number }).n).toBe(before + 2);
    const byReason = Object.fromEntries(rows.map((r) => [r.reason, r.qty_pcs]));
    expect(byReason.damage).toBe(-4);
    expect(byReason.color_defect).toBe(-10); // was reported as 14 pcs of "damage"
  });
});

describe('voiding a job card leaves nothing behind', () => {
  it('its FIFO allocations are removed, so a later cutting edit cannot inherit them', async () => {
    const { jobId } = await freshChain('ALLOC-1', 24);
    const lineId = (
      ctx.db.prepare('SELECT id FROM job_card_lines WHERE job_card_id = ?').get(jobId) as { id: number }
    ).id;
    expect(
      (ctx.db.prepare('SELECT COUNT(*) AS n FROM job_allocations WHERE job_card_line_id = ?').get(lineId) as { n: number }).n,
    ).toBeGreaterThan(0);

    const voided = await post(`/api/jobs/${jobId}/void`, admin, { reason: 'issued to the wrong contractor' });
    expect(voided.status).toBe(200);
    expect(
      (ctx.db.prepare('SELECT COUNT(*) AS n FROM job_allocations WHERE job_card_line_id = ?').get(lineId) as { n: number }).n,
    ).toBe(0);
  });
});

describe('a settled job card is closed for business', () => {
  it('refuses further receipts instead of billing the contractor for goods from nowhere', async () => {
    const { jobId, lineId } = await freshChain('DONE-1', 24);
    const first = await receive(jobId, lineId, 24);
    expect(first.body.status).toBe('completed');

    const more = await receive(jobId, lineId, 12, '2026-07-06');
    expect(more.status).toBe(409);
    expect(more.body.error).toMatch(/already fully settled/i);

    // the bill is exactly the 24 pcs that were issued: 2 dz x Rs30 = Rs60
    const cards = await request(ctx.app).get('/api/jobs').set('Cookie', owner);
    const card = (cards.body.items as Array<Record<string, unknown>>).find((c) => c.id === jobId)!;
    expect(card.receivedPcs).toBe(24);
    expect(card.jobCostPaise).toBe(6000);
  });
});

describe('every screen agrees on what a contractor is owed', () => {
  it('split deliveries do not drift between the job card, the dues page and the dashboard', async () => {
    // 5 receipts of 7 pcs at Rs10/dz is the classic rounding trap
    const { jobId, lineId } = await freshChain('ROUND-1', 35);
    ctx.db.prepare('UPDATE job_card_lines SET rate_paise_per_dozen = 1000 WHERE id = ?').run(lineId);
    for (let i = 0; i < 5; i++) {
      const res = await receive(jobId, lineId, 7, `2026-07-${String(10 + i).padStart(2, '0')}`);
      expect(res.status).toBe(201);
    }

    const cards = await request(ctx.app).get('/api/jobs').set('Cookie', owner);
    const card = (cards.body.items as Array<Record<string, unknown>>).find((c) => c.id === jobId)!;
    const cardCost = card.jobCostPaise as number;

    const analytics = await request(ctx.app).get('/api/contractors/analytics').set('Cookie', owner);
    const meena = (analytics.body.items as Array<Record<string, unknown>>).find((c) => c.name === 'Meena')!;

    // every job for Meena, summed the same way on both screens
    const allCards = (cards.body.items as Array<Record<string, unknown>>).filter(
      (c) => c.contractorName === 'Meena' && !c.voidedAt,
    );
    const sumOfCards = allCards.reduce((s, c) => s + (c.jobCostPaise as number), 0);
    expect(meena.jobWorkCostPaise).toBe(sumOfCards);
    expect(cardCost).toBe(Math.round((35 * 1000) / 12)); // 2917, rounded once
  });
});

describe('checker pay follows the work actually done', () => {
  it('pieces reported missing are not paid for (they never reached the checker)', async () => {
    const { jobId, lineId } = await freshChain('MISS-1');
    await receive(jobId, lineId, 120);
    const check = await post('/api/checking', operator, {
      issueDate: '2026-07-06',
      staffId: 2, // Ravi, Rs3.00/dz
      lotType: 'receipt_line',
      lotId: lastReceiptLine(jobId),
      qtyPcs: 120,
      notes: '',
    });
    const before = await request(ctx.app).get('/api/staff/analytics').set('Cookie', owner);
    const ravibefore = (before.body.items as Array<Record<string, unknown>>).find((s) => s.name === 'Ravi')!;

    await post(`/api/checking/${check.body.id}/results`, operator, {
      resultDate: '2026-07-07',
      qtyPassed: 96,
      rejections: [
        { reason: 'stitching_issue', qtyPcs: 12 },
        { reason: 'missing', qtyPcs: 12 },
      ],
      notes: '',
    });

    const after = await request(ctx.app).get('/api/staff/analytics').set('Cookie', owner);
    const ravi = (after.body.items as Array<Record<string, unknown>>).find((s) => s.name === 'Ravi')!;
    const checkedDelta = (ravi.checkedPcs as number) - (ravibefore.checkedPcs as number);
    const earnedDelta = (ravi.earnedPaise as number) - (ravibefore.earnedPaise as number);
    expect(checkedDelta).toBe(108); // 96 passed + 12 rejected — NOT the 12 missing
    expect(earnedDelta).toBe(Math.round((108 * 300) / 12));
  });
});

describe('the books still balance after all of it', () => {
  it('reconciliation is green', async () => {
    const res = await request(ctx.app).get('/api/system/reconciliation').set('Cookie', admin);
    expect(res.body.ok, JSON.stringify(res.body.checks)).toBe(true);
  });
});
