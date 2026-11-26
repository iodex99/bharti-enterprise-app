import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { loginAs, makeTestContext, type TestContext } from '../helpers';

/**
 * ADR-046/047 end to end:
 *  - rejected pieces go straight back to the contractor (WIP on their job line), the
 *    card reopens, and they are paid only once the fixed pieces pass checking;
 *  - missing pieces are deducted from the contractor;
 *  - every person's ledger/statement equals their dues TO THE PAISA, with a period
 *    filter and a PDF;
 *  - the new edits (check issue, pack issue, job rates, receipt, payment, dispatch,
 *    purchase after cutting) move stock only through the ledger and keep it balanced.
 */
let ctx: TestContext;
let admin: string;
let operator: string;
let owner: string;
let purchaseId = 0;
let jobCardId = 0;
let lineId = 0;
let checkId = 0;
let modelM1 = 0;

const stage = (name: string) =>
  (
    ctx.db
      .prepare('SELECT COALESCE(SUM(qty),0) AS q FROM stock_ledger WHERE stage = ?')
      .get(name) as { q: number }
  ).q;

async function dues(): Promise<number> {
  const res = await request(ctx.app).get('/api/contractors/analytics').set('Cookie', owner);
  return (res.body.items as Array<{ id: number; duesPaise: number }>).find((c) => c.id === 1)!
    .duesPaise;
}

async function receive(qty: number, date: string) {
  const res = await request(ctx.app)
    .post(`/api/jobs/${jobCardId}/receipts`)
    .set('Cookie', operator)
    .send({
      receiptDate: date,
      imagePath: '/uploads/2026-08/back.webp',
      lines: [{ jobCardLineId: lineId, qtyPcs: qty, returnType: 'stitched' }],
    });
  expect(res.status).toBe(201);
  return res.body.id as number;
}

async function issueLatestBatch(qty: number, staffId = 1, date = '2026-08-06') {
  const pending = await request(ctx.app).get('/api/checking/pending').set('Cookie', owner);
  const batch = (
    pending.body.items as Array<{ lotType: string; lotId: number; qtyPcs: number }>
  ).at(-1)!;
  const res = await request(ctx.app)
    .post('/api/checking')
    .set('Cookie', operator)
    .send({
      issueDate: date,
      staffId,
      lotType: batch.lotType,
      lotId: batch.lotId,
      qtyPcs: qty,
      notes: '',
    });
  expect(res.status).toBe(201);
  return res.body.id as number;
}

beforeAll(async () => {
  ctx = await makeTestContext();
  admin = await loginAs(ctx.app, 'admin', 'Admin@123');
  operator = await loginAs(ctx.app, 'operator', 'Operator@123');
  owner = await loginAs(ctx.app, 'owner', 'Owner@123');
  ctx.db.exec(`
    INSERT INTO colors (id, name, created_by) VALUES (1, 'Black', 1), (2, 'Navy', 1);
    INSERT INTO sizes (id, code, sort_order, created_by) VALUES (1, 'HR', 1, 1);
    INSERT INTO vendors (id, name, created_by) VALUES (1, 'V1', 1);
    INSERT INTO contractors (id, name, mobile, default_rate_paise_per_dozen, created_by) VALUES (1, 'Meena', '9800000001', 3050, 1);
    INSERT INTO staff (id, name, role, default_rate_paise_per_dozen, created_by) VALUES
      (1, 'Pooja', 'both', 300, 1), (2, 'Ravi', 'both', 250, 1);
  `);

  const purchase = await request(ctx.app).post('/api/purchases').set('Cookie', operator).send({
    purchaseDate: '2026-08-01',
    receivedDate: '2026-08-01',
    vendorId: 1,
    colorId: 1,
    lenInchC: 180000,
    widthInchC: 4400,
    ratePaisePerYard: 4000,
    notes: '',
  });
  purchaseId = purchase.body.id;
  const cut = await request(ctx.app)
    .post('/api/cutting')
    .set('Cookie', operator)
    .send({
      cutDate: '2026-08-02',
      rawLotType: 'purchase',
      rawLotId: purchaseId,
      notes: '',
      lines: [{ sizeId: 1, code: 'M1', qtyPcs: 120, clothPerPcInchC: 1000, widthCount: 3 }],
    });
  expect(cut.status).toBe(201);
  modelM1 = (ctx.db.prepare("SELECT id FROM models WHERE code = 'M1'").get() as { id: number }).id;
  // ₹30.50/dz: an awkward rate, so per-event rounding would drift if done naively
  const job = await request(ctx.app)
    .post('/api/jobs')
    .set('Cookie', operator)
    .send({
      issueDate: '2026-08-03',
      contractorId: 1,
      notes: '',
      lines: [
        {
          modelId: modelM1,
          colorId: 1,
          sizeId: 1,
          qtyIssuedPcs: 120,
          unitEntered: 'dozens',
          ratePaisePerDozen: 3050,
        },
      ],
    });
  jobCardId = job.body.cards[0].id;
  lineId = (
    ctx.db.prepare('SELECT id FROM job_card_lines WHERE job_card_id = ?').get(jobCardId) as {
      id: number;
    }
  ).id;
});
afterAll(() => ctx.cleanup());

describe('rejected → back to the contractor, missing → deducted', () => {
  it('records a check with rejections + missing and moves the rejects to WIP on the job line', async () => {
    await receive(120, '2026-08-05');
    expect(await dues()).toBe(30500); // 120 pcs = 10 dz × ₹30.50

    checkId = await issueLatestBatch(120);
    const res = await request(ctx.app)
      .post(`/api/checking/${checkId}/results`)
      .set('Cookie', operator)
      .send({
        resultDate: '2026-08-07',
        qtyPassed: 105,
        rejections: [
          { reason: 'stitching_issue', qtyPcs: 7 },
          { reason: 'damage', qtyPcs: 5 },
          { reason: 'missing', qtyPcs: 3 },
        ],
        notes: '',
      });
    expect(res.status).toBe(201);

    expect(stage('WIP')).toBe(12); // 7 + 5 back with Meena
    expect(stage('REJECTED')).toBe(0);
    const wipRows = ctx.db
      .prepare(
        "SELECT lot_type, lot_id, contractor_id FROM stock_ledger WHERE stage = 'WIP' AND ref_type = 'check_reject'",
      )
      .all() as Array<{ lot_type: string; lot_id: number; contractor_id: number }>;
    expect(wipRows).toEqual([{ lot_type: 'job_line', lot_id: lineId, contractor_id: 1 }]);

    const jobs = await request(ctx.app).get('/api/jobs').set('Cookie', owner);
    const card = jobs.body.items.find((j: { id: number }) => j.id === jobCardId);
    expect(card.status).toBe('partially_received');
    expect(card.pendingPcs).toBe(12);
    expect(card.reworkPcs).toBe(12);
    expect(card.missingPcs).toBe(3);
    // (120 − 12 − 3) = 105 pcs × 3050 / 12 = 26687.5 → 26688
    expect(card.jobCostPaise).toBe(26688);
    expect(await dues()).toBe(26688);
  });

  it('the fixed pieces come back through a normal receipt and are paid once they pass', async () => {
    // cannot receive more than is owed without a reason (12 owed)
    await receive(12, '2026-08-10');
    const jobs = await request(ctx.app).get('/api/jobs').set('Cookie', owner);
    const card = jobs.body.items.find((j: { id: number }) => j.id === jobCardId);
    expect(card.status).toBe('completed');
    expect(card.pendingPcs).toBe(0);
    // received 132 in total, 12 sent back: payable is 120 − 3 missing = 117
    expect(card.jobCostPaise).toBe(Math.round((117 * 3050) / 12));

    const recheck = await issueLatestBatch(12, 2, '2026-08-11');
    const res = await request(ctx.app)
      .post(`/api/checking/${recheck}/results`)
      .set('Cookie', operator)
      .send({ resultDate: '2026-08-11', qtyPassed: 12, rejections: [], notes: '' });
    expect(res.status).toBe(201);
    expect(stage('WIP')).toBe(0);
    expect(stage('PACKING')).toBe(117);
  });

  it('rejects from OPENING stock (no contractor) still go to REJECTED', async () => {
    const ob = await request(ctx.app).post('/api/opening-balances').set('Cookie', admin).send({
      balanceDate: '2026-08-01',
      stage: 'CHECKING',
      modelCode: 'M1',
      colorId: 1,
      sizeId: 1,
      qty: 10,
      note: '',
    });
    expect(ob.status).toBe(201);
    const issue = await request(ctx.app)
      .post('/api/checking')
      .set('Cookie', operator)
      .send({
        issueDate: '2026-08-12',
        staffId: 1,
        lotType: 'opening',
        lotId: ob.body.id,
        qtyPcs: 10,
        notes: '',
      });
    const res = await request(ctx.app)
      .post(`/api/checking/${issue.body.id}/results`)
      .set('Cookie', operator)
      .send({
        resultDate: '2026-08-12',
        qtyPassed: 8,
        rejections: [{ reason: 'damage', qtyPcs: 2 }],
        notes: '',
      });
    expect(res.status).toBe(201);
    expect(stage('REJECTED')).toBe(2);
    expect(
      (ctx.db.prepare('SELECT COUNT(*) AS n FROM contractor_adjustments').get() as { n: number }).n,
    ).toBe(3);
  });
});

describe('ledgers and statements', () => {
  it('contractor statement: every event priced, balance = dues to the paisa', async () => {
    const pay = await request(ctx.app)
      .post('/api/contractors/payments')
      .set('Cookie', operator)
      .send({
        contractorId: 1,
        paymentDate: '2026-08-15',
        amountPaise: 10000,
        mode: 'upi',
        reference: 'UPI-1',
        notes: '',
      });
    expect(pay.status).toBe(201);

    const res = await request(ctx.app).get('/api/contractors/1/statement').set('Cookie', owner);
    expect(res.status).toBe(200);
    const st = res.body;
    expect(st.party).toMatchObject({ kind: 'contractor', name: 'Meena' });
    expect(st.totals.closingBalancePaise).toBe(await dues());
    expect(st.totals.workPcs).toBe(132);
    expect(st.totals.reworkPcs).toBe(12);
    expect(st.totals.missingPcs).toBe(3);
    expect(st.totals.paidPaise).toBe(10000);
    expect(st.totals.earnedPaise - st.totals.reworkPaise - st.totals.missingPaise).toBe(
      Math.round((117 * 3050) / 12),
    );
    const kinds = (st.entries as Array<{ kind: string }>).map((e) => e.kind);
    expect(kinds).toEqual(['work', 'rework', 'rework', 'missing', 'work', 'payment']);
    // the running balance ends at the closing balance
    expect(st.entries.at(-1).balancePaise).toBe(st.totals.closingBalancePaise);
    // the breakdown shows the working: one job line, received/rework/missing/net
    expect(st.breakdown).toHaveLength(1);
    expect(st.breakdown[0]).toMatchObject({
      workPcs: 132,
      reworkPcs: 12,
      missingPcs: 3,
      netPcs: 117,
    });
  });

  it('a period shows an opening balance and only the rows inside it', async () => {
    const all = (await request(ctx.app).get('/api/contractors/1/statement').set('Cookie', owner))
      .body;
    const res = await request(ctx.app)
      .get('/api/contractors/1/statement?from=2026-08-10&to=2026-08-31')
      .set('Cookie', owner);
    const st = res.body;
    const before = (all.entries as Array<{ date: string; amountPaise: number }>)
      .filter((e) => e.date < '2026-08-10')
      .reduce((s, e) => s + e.amountPaise, 0);
    expect(st.openingBalancePaise).toBe(before);
    expect((st.entries as Array<{ kind: string }>).map((e) => e.kind)).toEqual(['work', 'payment']);
    expect(st.totals.closingBalancePaise).toBe(all.totals.closingBalancePaise);
    // junk dates are ignored rather than erroring
    const junk = await request(ctx.app)
      .get('/api/contractors/1/statement?from=yesterday')
      .set('Cookie', owner);
    expect(junk.status).toBe(200);
    expect(junk.body.period.from).toBeNull();
  });

  it('staff statement matches staff dues; checking pays inspected pieces, never missing', async () => {
    const st = (await request(ctx.app).get('/api/staff/1/statement').set('Cookie', owner)).body;
    const analytics = (await request(ctx.app).get('/api/staff/analytics').set('Cookie', owner)).body
      .items as Array<{
      id: number;
      duesPaise: number;
    }>;
    expect(st.totals.closingBalancePaise).toBe(analytics.find((a) => a.id === 1)!.duesPaise);
    // Pooja: 117 inspected (105 + 12 rejected; 3 missing unpaid) + 10 from opening
    expect(st.totals.workPcs).toBe(127);
  });

  it('PDF statements are real PDFs with a safe file name', async () => {
    const res = await request(ctx.app)
      .get('/api/contractors/1/statement/pdf?from=2026-08-01&to=2026-08-31')
      .set('Cookie', operator)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain('Statement-Meena-2026-08-31.pdf');
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

    const staffPdf = await request(ctx.app).get('/api/staff/2/statement/pdf').set('Cookie', owner);
    expect(staffPdf.status).toBe(200);
    const missing = await request(ctx.app).get('/api/staff/999/statement/pdf').set('Cookie', owner);
    expect(missing.status).toBe(404);
  });

  it('non-Latin names cannot break the PDF', async () => {
    ctx.db.prepare("UPDATE contractors SET name = 'मीना Meena' WHERE id = 1").run();
    const res = await request(ctx.app).get('/api/contractors/1/statement/pdf').set('Cookie', owner);
    expect(res.status).toBe(200);
    ctx.db.prepare("UPDATE contractors SET name = 'Meena' WHERE id = 1").run();
  });

  it('payment edits are admin-only and re-price the balance', async () => {
    const payId = (
      ctx.db.prepare('SELECT id FROM contractor_payments ORDER BY id LIMIT 1').get() as {
        id: number;
      }
    ).id;
    const body = {
      paymentDate: '2026-08-15',
      amountPaise: 15000,
      mode: 'cash',
      reference: '',
      notes: 'corrected',
    };
    const byOperator = await request(ctx.app)
      .put(`/api/contractors/payments/${payId}`)
      .set('Cookie', operator)
      .send(body);
    expect(byOperator.status).toBe(403);
    const before = await dues();
    const byAdmin = await request(ctx.app)
      .put(`/api/contractors/payments/${payId}`)
      .set('Cookie', admin)
      .send(body);
    expect(byAdmin.status).toBe(200);
    expect(await dues()).toBe(before - 5000);
    const audit = ctx.db
      .prepare(
        "SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'contractor_payment' AND action = 'update'",
      )
      .get() as { n: number };
    expect(audit.n).toBe(1);
  });
});

describe('edits everywhere — through the ledger only', () => {
  it('job card: rates can change after receipts (dues re-price), quantities cannot', async () => {
    const rateEdit = await request(ctx.app)
      .put(`/api/jobs/${jobCardId}`)
      .set('Cookie', operator)
      .send({
        issueDate: '2026-08-03',
        notes: 'rate corrected',
        lines: [{ sizeId: 1, qtyIssuedPcs: 120, unitEntered: 'dozens', ratePaisePerDozen: 3600 }],
      });
    expect(rateEdit.status).toBe(200);
    const jobs = await request(ctx.app).get('/api/jobs').set('Cookie', owner);
    expect(jobs.body.items.find((j: { id: number }) => j.id === jobCardId).jobCostPaise).toBe(
      117 * 300,
    );

    const qtyEdit = await request(ctx.app)
      .put(`/api/jobs/${jobCardId}`)
      .set('Cookie', operator)
      .send({
        issueDate: '2026-08-03',
        notes: '',
        lines: [{ sizeId: 1, qtyIssuedPcs: 100, unitEntered: 'dozens', ratePaisePerDozen: 3600 }],
      });
    expect(qtyEdit.status).toBe(409);
    expect(qtyEdit.body.error).toMatch(/date, notes and rates/);
  });

  it('receipt: date, photo and notes can be corrected', async () => {
    const receiptId = (
      ctx.db.prepare('SELECT id FROM job_receipts ORDER BY id LIMIT 1').get() as { id: number }
    ).id;
    const ok = await request(ctx.app)
      .put(`/api/jobs/receipts/${receiptId}`)
      .set('Cookie', operator)
      .send({
        receiptDate: '2026-08-04',
        imagePath: '/uploads/2026-08/better.webp',
        notes: 'retaken',
      });
    expect(ok.status).toBe(200);
    const row = ctx.db
      .prepare('SELECT receipt_date, image_path FROM job_receipts WHERE id = ?')
      .get(receiptId);
    expect(row).toEqual({ receipt_date: '2026-08-04', image_path: '/uploads/2026-08/better.webp' });
    const noPhoto = await request(ctx.app)
      .put(`/api/jobs/receipts/${receiptId}`)
      .set('Cookie', operator)
      .send({ receiptDate: '2026-08-04', imagePath: '', notes: '' });
    expect(noPhoto.status).toBe(400);
  });

  it('check issue: checker/quantity before results (stock moves back and out), rate after', async () => {
    // a fresh batch to work on: 24 pcs of opening stock waiting for checking
    const ob = await request(ctx.app).post('/api/opening-balances').set('Cookie', admin).send({
      balanceDate: '2026-08-01',
      stage: 'CHECKING',
      modelCode: 'M1',
      colorId: 1,
      sizeId: 1,
      qty: 24,
      note: '',
    });
    const issue = await request(ctx.app)
      .post('/api/checking')
      .set('Cookie', operator)
      .send({
        issueDate: '2026-08-21',
        staffId: 1,
        lotType: 'opening',
        lotId: ob.body.id,
        qtyPcs: 24,
        notes: '',
      });
    const id = issue.body.id as number;

    const moved = await request(ctx.app)
      .put(`/api/checking/${id}`)
      .set('Cookie', operator)
      .send({
        issueDate: '2026-08-21',
        staffId: 2,
        qtyPcs: 18,
        ratePaisePerDozen: 400,
        notes: 'split',
      });
    expect(moved.status).toBe(200);
    const held = ctx.db
      .prepare(
        "SELECT staff_id, SUM(qty) AS q FROM stock_ledger WHERE stage='CHECKING' AND lot_type='check_issue' AND lot_id = ? GROUP BY staff_id HAVING SUM(qty) != 0",
      )
      .all(id);
    expect(held).toEqual([{ staff_id: 2, q: 18 }]);
    const pool = (
      ctx.db
        .prepare(
          "SELECT SUM(qty) AS q FROM stock_ledger WHERE stage='CHECKING' AND lot_type='opening' AND lot_id = ?",
        )
        .get(ob.body.id) as { q: number }
    ).q;
    expect(pool).toBe(6); // the 6 taken off went back to the batch

    await request(ctx.app)
      .post(`/api/checking/${id}/results`)
      .set('Cookie', operator)
      .send({ resultDate: '2026-08-22', qtyPassed: 6, rejections: [], notes: '' });
    const locked = await request(ctx.app)
      .put(`/api/checking/${id}`)
      .set('Cookie', operator)
      .send({ issueDate: '2026-08-21', staffId: 1, qtyPcs: 18, ratePaisePerDozen: 400, notes: '' });
    expect(locked.status).toBe(409);
    const rateOnly = await request(ctx.app)
      .put(`/api/checking/${id}`)
      .set('Cookie', operator)
      .send({ issueDate: '2026-08-21', staffId: 2, qtyPcs: 18, ratePaisePerDozen: 600, notes: '' });
    expect(rateOnly.status).toBe(200);
    // void still restores exactly what is held after the edit
    const ravi = (await request(ctx.app).get('/api/staff/2/statement').set('Cookie', owner)).body;
    expect(
      ravi.breakdown.find((b: { ref: string }) => b.ref === issue.body.docNo).amountPaise,
    ).toBe(300); // 6 pcs × ₹6/dz
  });

  it('pack now: the result and the hand-over to packing happen in one step', async () => {
    const id = (
      ctx.db
        .prepare("SELECT id FROM check_issues WHERE status = 'open' ORDER BY id DESC LIMIT 1")
        .get() as {
        id: number;
      }
    ).id;
    const res = await request(ctx.app)
      .post(`/api/checking/${id}/results`)
      .set('Cookie', operator)
      .send({ resultDate: '2026-08-23', qtyPassed: 12, rejections: [], notes: '', packNow: true });
    expect(res.status).toBe(201);
    expect(res.body.pack.docNo).toMatch(/^PCK-/);
    const pack = ctx.db
      .prepare('SELECT staff_id, qty_pcs FROM pack_issues WHERE id = ?')
      .get(res.body.pack.id);
    // the checker (Ravi) packs, and gets ALL passed pieces waiting on this batch (6 + 12)
    expect(pack).toEqual({ staff_id: 2, qty_pcs: 18 });
  });

  it('pack issue edit before results; packed register lists finished goods', async () => {
    const packId = (
      ctx.db.prepare('SELECT id FROM pack_issues ORDER BY id DESC LIMIT 1').get() as { id: number }
    ).id;
    const edit = await request(ctx.app)
      .put(`/api/packing/${packId}`)
      .set('Cookie', operator)
      .send({
        issueDate: '2026-08-23',
        staffId: 1,
        qtyPcs: 12,
        label: '',
        ratePaisePerDozen: 200,
        notes: '',
      });
    expect(edit.status).toBe(200);
    const res = await request(ctx.app)
      .post(`/api/packing/${packId}/results`)
      .set('Cookie', operator)
      .send({ resultDate: '2026-08-24', qtyPacked: 12, qtyShort: 0, notes: '' });
    expect(res.status).toBe(201);
    const packed = await request(ctx.app).get('/api/packing/packed').set('Cookie', owner);
    expect(packed.body.items[0]).toMatchObject({
      packedPcs: 12,
      staffName: 'Pooja',
      sizeCodeLabel: 'M1-HR',
    });
    // after results the packer is fixed
    const locked = await request(ctx.app)
      .put(`/api/packing/${packId}`)
      .set('Cookie', operator)
      .send({
        issueDate: '2026-08-23',
        staffId: 2,
        qtyPcs: 12,
        label: '',
        ratePaisePerDozen: 200,
        notes: '',
      });
    expect(locked.status).toBe(409);
  });

  it('voiding an EDITED pack issue puts back exactly the net it took', async () => {
    const checkIssue = (
      ctx.db.prepare('SELECT id FROM check_issues ORDER BY id DESC LIMIT 1').get() as { id: number }
    ).id;
    const poolBefore = stage('PACKING');
    const created = await request(ctx.app)
      .post(`/api/checking/${checkIssue}/pack`)
      .set('Cookie', operator)
      .send({ issueDate: '2026-08-24', staffId: 1, qtyPcs: 6, kind: 'pack', label: '', notes: '' });
    expect(created.status).toBe(201);
    const shrink = await request(ctx.app)
      .put(`/api/packing/${created.body.id}`)
      .set('Cookie', operator)
      .send({
        issueDate: '2026-08-24',
        staffId: 2,
        qtyPcs: 4,
        label: '',
        ratePaisePerDozen: 200,
        notes: '',
      });
    expect(shrink.status).toBe(200);
    const voided = await request(ctx.app)
      .post(`/api/packing/${created.body.id}/void`)
      .set('Cookie', admin)
      .send({ reason: 'mistake' });
    expect(voided.status).toBe(200);
    // all 6 back in the pool: nothing doubled, nothing lost
    const pool = (
      ctx.db
        .prepare(
          "SELECT SUM(qty) AS q FROM stock_ledger WHERE stage='PACKING' AND staff_id IS NULL AND lot_type='check_issue' AND lot_id = ?",
        )
        .get(checkIssue) as { q: number }
    ).q;
    expect(pool).toBe(6);
    expect(stage('PACKING')).toBe(poolBefore);
  });

  it('dispatch edit: old take goes back, the corrected quantity takes FIFO', async () => {
    const created = await request(ctx.app).post('/api/dispatches').set('Cookie', admin).send({
      dispatchDate: '2026-08-25',
      modelId: modelM1,
      colorId: 1,
      sizeId: 1,
      qtyPcs: 10,
      notes: '',
    });
    expect(created.status).toBe(201);
    expect(stage('FG')).toBe(2);
    const edit = await request(ctx.app)
      .put(`/api/dispatches/${created.body.id}`)
      .set('Cookie', admin)
      .send({
        dispatchDate: '2026-08-25',
        modelId: modelM1,
        colorId: 1,
        sizeId: 1,
        qtyPcs: 7,
        notes: 'short shipment',
      });
    expect(edit.status).toBe(200);
    expect(stage('FG')).toBe(5);
    const voided = await request(ctx.app)
      .post(`/api/dispatches/${created.body.id}/void`)
      .set('Cookie', admin)
      .send({ reason: 'cancelled' });
    expect(voided.status).toBe(200);
    expect(stage('FG')).toBe(12);
    const tooMany = await request(ctx.app).post('/api/dispatches').set('Cookie', admin).send({
      dispatchDate: '2026-08-25',
      modelId: modelM1,
      colorId: 1,
      sizeId: 1,
      qtyPcs: 5,
      notes: '',
    });
    const big = await request(ctx.app)
      .put(`/api/dispatches/${tooMany.body.id}`)
      .set('Cookie', admin)
      .send({
        dispatchDate: '2026-08-25',
        modelId: modelM1,
        colorId: 1,
        sizeId: 1,
        qtyPcs: 500,
        notes: '',
      });
    expect(big.status).toBe(409);
    expect(stage('FG')).toBe(7); // the failed edit changed nothing
  });

  it('purchase after cutting: color/width locked, length never below what was cut', async () => {
    const base = {
      purchaseDate: '2026-08-01',
      receivedDate: '2026-08-01',
      vendorId: 1,
      colorId: 1,
      lenInchC: 180000,
      widthInchC: 4400,
      ratePaisePerYard: 4000,
      notes: '',
    };
    const color = await request(ctx.app)
      .put(`/api/purchases/${purchaseId}`)
      .set('Cookie', operator)
      .send({ ...base, colorId: 2 });
    expect(color.status).toBe(409);
    const width = await request(ctx.app)
      .put(`/api/purchases/${purchaseId}`)
      .set('Cookie', operator)
      .send({ ...base, widthInchC: 5000 });
    expect(width.status).toBe(409);
    const tooShort = await request(ctx.app)
      .put(`/api/purchases/${purchaseId}`)
      .set('Cookie', operator)
      .send({ ...base, lenInchC: 30000 });
    expect(tooShort.status).toBe(409);
    expect(tooShort.body.error).toMatch(/already cut/);
    const longer = await request(ctx.app)
      .put(`/api/purchases/${purchaseId}`)
      .set('Cookie', operator)
      .send({ ...base, lenInchC: 200000, vendorId: 1 });
    expect(longer.status).toBe(200);
    expect(stage('RAW')).toBe(200000 - 40000);
  });

  it('opening balance: quantity corrects through the ledger, never below what was used', async () => {
    // the 24-pc CHECKING opening lot: 18 went to a checker, 6 are still in the pool
    const ob = ctx.db
      .prepare("SELECT id FROM opening_balances WHERE stage = 'CHECKING' AND qty = 24")
      .get() as { id: number };
    const tooLow = await request(ctx.app)
      .put(`/api/opening-balances/${ob.id}`)
      .set('Cookie', admin)
      .send({ balanceDate: '2026-08-01', qty: 12, note: '' });
    expect(tooLow.status).toBe(409);
    const ok = await request(ctx.app)
      .put(`/api/opening-balances/${ob.id}`)
      .set('Cookie', admin)
      .send({ balanceDate: '2026-07-31', qty: 30, note: 'recounted' });
    expect(ok.status).toBe(200);
    const lot = (
      ctx.db
        .prepare(
          "SELECT SUM(qty) AS q FROM stock_ledger WHERE stage='CHECKING' AND lot_type='opening' AND lot_id = ?",
        )
        .get(ob.id) as { q: number }
    ).q;
    expect(lot).toBe(12); // 6 waiting + the 6 added
    const byOperator = await request(ctx.app)
      .put(`/api/opening-balances/${ob.id}`)
      .set('Cookie', operator)
      .send({ balanceDate: '2026-07-31', qty: 30, note: '' });
    expect(byOperator.status).toBe(403);
  });

  it('the books still balance: every reconciliation check is green', async () => {
    const res = await request(ctx.app).get('/api/system/reconciliation').set('Cookie', admin);
    expect(res.status).toBe(200);
    const failed = (res.body.checks as Array<{ ok: boolean; name: string; detail: string }>).filter(
      (c) => !c.ok,
    );
    expect(failed).toEqual([]);
  });
});
