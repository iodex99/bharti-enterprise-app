import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { loginAs, makeTestContext, type TestContext } from '../helpers';

/**
 * Phase 7: checking → packing → FG → dispatch, ending in the FULL-CHAIN CONSERVATION
 * PROOF: every piece that ever existed is accounted for across current stock and
 * terminal losses, with zero drift.
 */
let ctx: TestContext;
let admin: string;
let operator: string;
let owner: string;
let receiptLineId: number;
let modelM1 = 0;

// cutting: 120 pcs × 10" ×3 across = 40 strips × 1000 = 40000 inch_c consumed
const CUT_LEN = 40000;

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
    INSERT INTO sizes (id, code, sort_order, created_by) VALUES (1, 'XS', 1, 1);
    INSERT INTO vendors (id, name, created_by) VALUES (1, 'V1', 1);
    INSERT INTO contractors (id, name, default_rate_paise_per_dozen, created_by) VALUES (1, 'Meena', 3000, 1);
    INSERT INTO staff (id, name, role, created_by) VALUES
      (1, 'Pooja', 'checker', 1), (2, 'Ravi', 'packer', 1), (3, 'Kavita', 'both', 1);
  `);

  // purchase (no code — given at cutting) → cut 120 pcs → job → receive all 120
  // stitched (with the REQUIRED photo) into the pending-checking pool
  const purchase = await request(ctx.app).post('/api/purchases').set('Cookie', operator).send({
    purchaseDate: '2026-07-01',
    receivedDate: '2026-07-01',
    vendorId: 1,
    colorId: 1,
    lenInchC: 180000, // 50 yd
    widthInchC: 4400,
    ratePaisePerYard: 4000,
    notes: '',
  });
  const cutRes = await request(ctx.app)
    .post('/api/cutting')
    .set('Cookie', operator)
    .send({
      cutDate: '2026-07-02',
      rawLotType: 'purchase',
      rawLotId: purchase.body.id,
      notes: '',
      lines: [{ sizeId: 1, code: 'M1', qtyPcs: 120, clothPerPcInchC: 1000, widthCount: 3 }],
    });
  if (cutRes.status !== 201) throw new Error(`fixture cutting failed: ${cutRes.text}`);
  modelM1 = (ctx.db.prepare("SELECT id FROM models WHERE code = 'M1'").get() as { id: number }).id;
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
    ctx.db.prepare('SELECT id FROM job_card_lines WHERE job_card_id = ?').get(jobCardId) as {
      id: number;
    }
  ).id;
  const receipt = await request(ctx.app)
    .post(`/api/jobs/${jobCardId}/receipts`)
    .set('Cookie', operator)
    .send({
      receiptDate: '2026-07-05',
      imagePath: '/uploads/2026-07/returned-goods.webp',
      lines: [{ jobCardLineId: lineId, qtyPcs: 120, returnType: 'stitched' }],
    });
  receiptLineId = (
    ctx.db
      .prepare('SELECT id FROM job_receipt_lines WHERE job_receipt_id = ?')
      .get(receipt.body.id) as { id: number }
  ).id;
});
afterAll(() => ctx.cleanup());

describe('checking', () => {
  let checkId: number;

  it('lists the received batch as pending-for-checking with contractor + photo', async () => {
    const res = await request(ctx.app).get('/api/checking/pending').set('Cookie', owner);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    const batch = res.body.items[0];
    expect(batch.lotType).toBe('receipt_line');
    expect(batch.lotId).toBe(receiptLineId);
    expect(batch.qtyPcs).toBe(120);
    expect(batch.contractorName).toBe('Meena'); // the contractor ↔ batch mapping
    expect(batch.receiptDocNo).toBe('RCT-0001');
    expect(batch.imagePath).toBe('/uploads/2026-07/returned-goods.webp');
  });

  it('issues the SPECIFIC received batch to a checker (any staff can check)', async () => {
    // staff 2 has legacy role 'packer' — roles no longer restrict who checks
    const res = await request(ctx.app).post('/api/checking').set('Cookie', operator).send({
      issueDate: '2026-07-06',
      staffId: 2,
      lotType: 'receipt_line',
      lotId: receiptLineId,
      qtyPcs: 120,
      notes: '',
    });
    expect(res.status).toBe(201);
    expect(res.body.docNo).toBe('CHK-0001');
    checkId = res.body.id as number;
    // the directed allocation records exactly the chosen batch
    const allocations = ctx.db
      .prepare('SELECT * FROM check_allocations WHERE check_issue_id = ?')
      .all(checkId) as Array<{ checking_lot_type: string; checking_lot_id: number; qty_pcs: number }>;
    expect(allocations).toHaveLength(1);
    expect(allocations[0]!.checking_lot_id).toBe(receiptLineId);
    expect(stageTotal('CHECKING')).toBe(120);
    // and the batch is no longer pending
    const pending = await request(ctx.app).get('/api/checking/pending').set('Cookie', owner);
    expect(pending.body.items).toHaveLength(0);
  });

  it('rejects over-issue from the batch and unknown batches', async () => {
    const overIssue = await request(ctx.app).post('/api/checking').set('Cookie', operator).send({
      issueDate: '2026-07-06',
      staffId: 1,
      lotType: 'receipt_line',
      lotId: receiptLineId,
      qtyPcs: 10,
    });
    expect(overIssue.status).toBe(409);
    expect(overIssue.body.error).toMatch(/has only 0 pcs/i);

    const badLot = await request(ctx.app).post('/api/checking').set('Cookie', operator).send({
      issueDate: '2026-07-06',
      staffId: 1,
      lotType: 'receipt_line',
      lotId: 99999,
      qtyPcs: 10,
    });
    expect(badLot.status).toBe(400);
    expect(badLot.body.error).toMatch(/not found/i);
  });

  it('incremental results: pass + ONE rejected breakdown (missing is a reason)', async () => {
    // session 1: 60 passed, 6 rejected (4 stitching + 2 elastic)
    const s1 = await request(ctx.app)
      .post(`/api/checking/${checkId}/results`)
      .set('Cookie', operator)
      .send({
        resultDate: '2026-07-07',
        qtyPassed: 60,
        rejections: [
          { reason: 'stitching_issue', qtyPcs: 4 },
          { reason: 'elastic_issue', qtyPcs: 2 },
        ],
        notes: '',
      });
    expect(s1.status).toBe(201);
    expect(s1.body.status).toBe('open'); // 54 still with checker

    // cannot exceed what the checker holds
    const tooMuch = await request(ctx.app)
      .post(`/api/checking/${checkId}/results`)
      .set('Cookie', operator)
      .send({ resultDate: '2026-07-07', qtyPassed: 60, rejections: [] });
    expect(tooMuch.status).toBe(409);

    // session 2 completes: 52 passed, 2 MISSING — entered as a rejection reason, but
    // written off internally (missing pieces cannot sit in REJECTED stock)
    const s2 = await request(ctx.app)
      .post(`/api/checking/${checkId}/results`)
      .set('Cookie', operator)
      .send({
        resultDate: '2026-07-08',
        qtyPassed: 52,
        rejections: [{ reason: 'missing', qtyPcs: 2 }],
        notes: 'lost in transit',
      });
    expect(s2.status).toBe(201);
    expect(s2.body.status).toBe('completed');

    expect(stageTotal('PACKING')).toBe(112);
    expect(stageTotal('REJECTED')).toBe(6);
    expect(stageTotal('CHECKING')).toBe(0);

    const list = await request(ctx.app).get('/api/checking').set('Cookie', owner);
    const issue = list.body.items.find((i: { id: number }) => i.id === checkId);
    expect(issue.passedPcs).toBe(112);
    expect(issue.rejectedPcs).toBe(6);
    expect(issue.missingPcs).toBe(2);
    expect(issue.pendingPcs).toBe(0);
    // the checker ↔ contractor mapping travels with the issue
    expect(issue.contractorName).toBe('Meena');
    expect(issue.receiptDocNo).toBe('RCT-0001');
    expect(issue.receiptImagePath).toBe('/uploads/2026-07/returned-goods.webp');

    // the missing-pieces discrepancy is attributed to checker AND source contractor
    const disc = await request(ctx.app).get('/api/discrepancies').set('Cookie', owner);
    const missingRow = (disc.body.items as Array<{ reason: string; party: string }>).find(
      (d) => d.reason === 'missing',
    );
    expect(missingRow).toBeDefined();
    expect(missingRow!.party).toContain('Ravi'); // the checker (staff 2)
    expect(missingRow!.party).toContain('Meena'); // ← the contractor whose batch it was
  });
});

describe('packing → finished goods → dispatch', () => {
  let packId: number;
  let bundleId: number;

  it('allots packing FROM the checking row: directed, bundles supported', async () => {
    const checkId = (
      ctx.db.prepare("SELECT id FROM check_issues WHERE doc_no = 'CHK-0001'").get() as { id: number }
    ).id;
    // keep 24 pcs aside as a labeled bundle first (ADR-035 #12)
    const bundle = await request(ctx.app)
      .post(`/api/checking/${checkId}/pack`)
      .set('Cookie', operator)
      .send({ issueDate: '2026-07-09', staffId: 2, qtyPcs: 24, kind: 'bundle', label: 'Festival reserve', notes: '' });
    expect(bundle.status).toBe(201);
    bundleId = bundle.body.id as number;

    // a bundle without a name is refused
    const noLabel = await request(ctx.app)
      .post(`/api/checking/${checkId}/pack`)
      .set('Cookie', operator)
      .send({ issueDate: '2026-07-09', staffId: 2, qtyPcs: 4, kind: 'bundle', label: '', notes: '' });
    expect(noLabel.status).toBe(400);

    // the rest goes to normal packing (staff 1 — legacy 'checker' role doesn't restrict)
    const res = await request(ctx.app)
      .post(`/api/checking/${checkId}/pack`)
      .set('Cookie', operator)
      .send({ issueDate: '2026-07-09', staffId: 1, qtyPcs: 88, kind: 'pack', label: '', notes: '' });
    expect(res.status).toBe(201);
    packId = res.body.id as number;

    // over-allotment from the same check issue is refused (0 left in its pool)
    const over = await request(ctx.app)
      .post(`/api/checking/${checkId}/pack`)
      .set('Cookie', operator)
      .send({ issueDate: '2026-07-09', staffId: 1, qtyPcs: 5, kind: 'pack', label: '', notes: '' });
    expect(over.status).toBe(409);

    // deactivated staff are still refused
    ctx.db.prepare('UPDATE staff SET is_active = 0 WHERE id = 3').run();
    const inactive = await request(ctx.app)
      .post(`/api/checking/${checkId}/pack`)
      .set('Cookie', operator)
      .send({ issueDate: '2026-07-09', staffId: 3, qtyPcs: 1, kind: 'pack', label: '', notes: '' });
    expect(inactive.status).toBe(400);
    expect(inactive.body.error).toMatch(/deactivated/i);
    ctx.db.prepare('UPDATE staff SET is_active = 1 WHERE id = 3').run();

    // bundles are listed distinctly, holding their pieces
    const bundles = await request(ctx.app).get('/api/packing?kind=bundle').set('Cookie', owner);
    expect(bundles.body.items).toHaveLength(1);
    expect(bundles.body.items[0].label).toBe('Festival reserve');
    expect(bundles.body.items[0].heldPcs).toBe(24);
  });

  it('packing from a BUNDLE later works and keeps the trace allocations', async () => {
    // move 12 pcs from the bundle to another packer (the rare different-person case)
    const fromBundle = await request(ctx.app).post('/api/packing').set('Cookie', operator).send({
      issueDate: '2026-07-10',
      staffId: 3,
      lotType: 'pack_issue',
      lotId: bundleId,
      qtyPcs: 12,
      kind: 'pack',
      label: '',
      notes: '',
    });
    expect(fromBundle.status).toBe(201);

    // trace continuity: the new issue's allocations point at the ORIGINAL check issue
    const allocs = ctx.db
      .prepare('SELECT packing_lot_type FROM pack_allocations WHERE pack_issue_id = ?')
      .all(fromBundle.body.id) as Array<{ packing_lot_type: string }>;
    expect(allocs.length).toBeGreaterThan(0);
    expect(allocs.every((a) => a.packing_lot_type === 'check_issue')).toBe(true);

    // pack those 12 to FG so the conservation numbers below stay whole
    const done = await request(ctx.app)
      .post(`/api/packing/${fromBundle.body.id}/results`)
      .set('Cookie', operator)
      .send({ resultDate: '2026-07-10', qtyPacked: 12, qtyShort: 0 });
    expect(done.status).toBe(201);
    expect(done.body.status).toBe('completed');
  });

  it('incremental pack results: packed to FG, short with reason', async () => {
    const s1 = await request(ctx.app)
      .post(`/api/packing/${packId}/results`)
      .set('Cookie', operator)
      .send({ resultDate: '2026-07-10', qtyPacked: 76, qtyShort: 0 });
    expect(s1.status).toBe(201);
    expect(s1.body.status).toBe('open');

    const shortNoReason = await request(ctx.app)
      .post(`/api/packing/${packId}/results`)
      .set('Cookie', operator)
      .send({ resultDate: '2026-07-11', qtyPacked: 10, qtyShort: 2 });
    expect(shortNoReason.status).toBe(400);

    const s2 = await request(ctx.app)
      .post(`/api/packing/${packId}/results`)
      .set('Cookie', operator)
      .send({ resultDate: '2026-07-11', qtyPacked: 10, qtyShort: 2, shortReason: 'damage' });
    expect(s2.status).toBe(201);
    expect(s2.body.status).toBe('completed');

    // 76 + 10 from this issue + 12 from the bundle = 98 in FG; 12 still bundled
    expect(stageTotal('FG')).toBe(98);
    expect(stageTotal('PACKING')).toBe(12);

    const fg = await request(ctx.app).get('/api/stock/FG').set('Cookie', owner);
    expect(fg.body.items[0].qty).toBe(98);
  });

  it('dispatch is admin-only, reduces FG, void restores it', async () => {
    const asOperator = await request(ctx.app).post('/api/dispatches').set('Cookie', operator).send({
      dispatchDate: '2026-07-11',
      modelId: modelM1,
      colorId: 1,
      sizeId: 1,
      qtyPcs: 24,
    });
    expect(asOperator.status).toBe(403);

    const res = await request(ctx.app).post('/api/dispatches').set('Cookie', admin).send({
      dispatchDate: '2026-07-11',
      modelId: modelM1,
      colorId: 1,
      sizeId: 1,
      qtyPcs: 24,
      notes: 'sold to Delhi shop',
    });
    expect(res.status).toBe(201);
    expect(stageTotal('FG')).toBe(74);

    const tooMany = await request(ctx.app).post('/api/dispatches').set('Cookie', admin).send({
      dispatchDate: '2026-07-11',
      modelId: modelM1,
      colorId: 1,
      sizeId: 1,
      qtyPcs: 500,
    });
    expect(tooMany.status).toBe(409);

    const voided = await request(ctx.app)
      .post(`/api/dispatches/${res.body.id}/void`)
      .set('Cookie', admin)
      .send({ reason: 'customer cancelled' });
    expect(voided.status).toBe(200);
    expect(stageTotal('FG')).toBe(98);
  });

  it('dashboard KPIs and alerts reflect the fixture ledger exactly', async () => {
    const res = await request(ctx.app).get('/api/dashboard').set('Cookie', owner);
    expect(res.status).toBe(200);
    const { kpis } = res.body as {
      kpis: Record<string, number>;
    };
    expect(kpis.rawLen).toBe(180000 - CUT_LEN);
    expect(kpis.cutPcs).toBe(0);
    expect(kpis.wipPcs).toBe(0);
    expect(kpis.fgPcs).toBe(98);
    expect(kpis.rejectedPcs).toBe(6);
    expect(kpis.openJobs).toBe(0);
    expect(kpis.completedJobs).toBe(1);
    expect(kpis.unresolvedDiscrepancies).toBeGreaterThan(0); // missing + rejects + short
    // dues: 120 pcs stitched @ ₹30/dz = ₹300 = 30000 paise, nothing paid
    expect(kpis.duesPaise).toBe(30000);

    const trends = (res.body as { trends: Array<{ cutPcs: number }> }).trends;
    expect(trends.reduce((s, t) => s + t.cutPcs, 0)).toBe(120);

    const alertsRes = await request(ctx.app).get('/api/dashboard/alerts').set('Cookie', owner);
    expect(alertsRes.status).toBe(200);
    const titles = (alertsRes.body.items as Array<{ title: string }>).map((a) => a.title);
    expect(titles.some((t) => /discrepanc/i.test(t))).toBe(true);

    const anon = await request(ctx.app).get('/api/dashboard');
    expect(anon.status).toBe(401);
  });

  it('FULL-CHAIN CONSERVATION: genesis minus terminal equals stock on hand, drift = 0', () => {
    const genesis = (
      ctx.db
        .prepare(
          `SELECT COALESCE(SUM(qty),0) AS q FROM stock_ledger
           WHERE ref_type IN ('opening','purchase','cutting_output','receipt_excess','adjustment_in')
             AND stage != 'RAW'`,
        )
        .get() as { q: number }
    ).q;
    const terminal = (
      ctx.db
        .prepare(
          `SELECT COALESCE(SUM(-qty),0) AS q FROM stock_ledger
           WHERE ref_type IN ('cutting_consume','job_shortage','check_missing','pack_short',
                              'reject_writeoff','dispatch','adjustment_out')
             AND stage != 'RAW'`,
        )
        .get() as { q: number }
    ).q;
    const onHand = (
      ctx.db
        .prepare("SELECT COALESCE(SUM(qty),0) AS q FROM stock_ledger WHERE stage != 'RAW'")
        .get() as { q: number }
    ).q;
    // 120 cut + 24 adjustment_in (dispatch void); destroyed: 2 missing + 2 pack short +
    // 24 dispatched (the void compensates via genesis, keeping history append-only)
    expect(genesis).toBe(144);
    expect(terminal).toBe(28);
    expect(onHand).toBe(genesis - terminal); // the invariant that matters: zero drift

    // per-stage breakdown proves where everything sits
    expect(stageTotal('CUT')).toBe(0);
    expect(stageTotal('WIP')).toBe(0);
    expect(stageTotal('CHECKING')).toBe(0);
    expect(stageTotal('FG')).toBe(98);
    expect(stageTotal('PACKING')).toBe(12); // the bundle still held aside
    expect(stageTotal('REJECTED')).toBe(6);
    // 98 + 12 + 6 = 116 = 120 - 4 ✓ zero drift

    // RAW conservation separately (length units)
    const rawIn = (
      ctx.db
        .prepare(
          "SELECT COALESCE(SUM(qty),0) AS q FROM stock_ledger WHERE stage='RAW' AND qty > 0",
        )
        .get() as { q: number }
    ).q;
    const rawOut = (
      ctx.db
        .prepare(
          "SELECT COALESCE(SUM(-qty),0) AS q FROM stock_ledger WHERE stage='RAW' AND qty < 0",
        )
        .get() as { q: number }
    ).q;
    expect(rawIn - rawOut).toBe(stageTotal('RAW'));
    expect(stageTotal('RAW')).toBe(180000 - CUT_LEN); // bought − computed cutting consumption
  });
});
