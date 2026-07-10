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
    INSERT INTO models (id, code, name, created_by) VALUES (1, 'M1', 'Model 1', 1);
    INSERT INTO colors (id, name, created_by) VALUES (1, 'Black', 1);
    INSERT INTO sizes (id, code, sort_order, created_by) VALUES (1, 'XS', 1, 1);
    INSERT INTO vendors (id, name, created_by) VALUES (1, 'V1', 1);
    INSERT INTO contractors (id, name, default_rate_paise_per_dozen, created_by) VALUES (1, 'Meena', 3000, 1);
    INSERT INTO staff (id, name, role, created_by) VALUES
      (1, 'Pooja', 'checker', 1), (2, 'Ravi', 'packer', 1), (3, 'Kavita', 'both', 1);
  `);

  // purchase → cut 120 pcs → job → receive all 120 stitched into CHECKING pool
  const purchase = await request(ctx.app).post('/api/purchases').set('Cookie', operator).send({
    purchaseDate: '2026-07-01',
    receivedDate: '2026-07-01',
    vendorId: 1,
    modelId: 1,
    colorId: 1,
    qtyCm: 10000,
    ratePaisePerMeter: 4000,
    notes: '',
  });
  const plan = await request(ctx.app)
    .post('/api/cutting')
    .set('Cookie', operator)
    .send({
      cutDate: '2026-07-02',
      rawLotType: 'purchase',
      rawLotId: purchase.body.id,
      metersUsedCm: 6000,
      lines: [{ sizeId: 1, expectedPcs: 120 }],
    });
  await request(ctx.app)
    .post(`/api/cutting/${plan.body.id}/actuals`)
    .set('Cookie', operator)
    .send({ lines: [{ sizeId: 1, actualPcs: 120 }] });
  const job = await request(ctx.app)
    .post('/api/jobs')
    .set('Cookie', operator)
    .send({
      issueDate: '2026-07-03',
      contractorId: 1,
      modelId: 1,
      colorId: 1,
      lines: [{ sizeId: 1, qtyIssuedPcs: 120, unitEntered: 'dozens', ratePaisePerDozen: 3000 }],
    });
  const lineId = (
    ctx.db.prepare('SELECT id FROM job_card_lines WHERE job_card_id = ?').get(job.body.id) as {
      id: number;
    }
  ).id;
  await request(ctx.app)
    .post(`/api/jobs/${job.body.id}/receipts`)
    .set('Cookie', operator)
    .send({
      receiptDate: '2026-07-05',
      lines: [{ jobCardLineId: lineId, qtyPcs: 120, returnType: 'stitched' }],
    });
});
afterAll(() => ctx.cleanup());

describe('checking', () => {
  let checkId: number;

  it('issues stitched goods to a checker (FIFO from the pool)', async () => {
    const res = await request(ctx.app).post('/api/checking').set('Cookie', operator).send({
      issueDate: '2026-07-06',
      staffId: 1,
      modelId: 1,
      colorId: 1,
      sizeId: 1,
      qtyPcs: 120,
      notes: '',
    });
    expect(res.status).toBe(201);
    expect(res.body.docNo).toBe('CHK-0001');
    checkId = res.body.id as number;
    // pool empty, checker holds 120
    const allocations = ctx.db
      .prepare('SELECT * FROM check_allocations WHERE check_issue_id = ?')
      .all(checkId);
    expect(allocations.length).toBeGreaterThan(0);
    expect(stageTotal('CHECKING')).toBe(120);
  });

  it('rejects packers as checkers and over-issue', async () => {
    const packerCheck = await request(ctx.app).post('/api/checking').set('Cookie', operator).send({
      issueDate: '2026-07-06',
      staffId: 2,
      modelId: 1,
      colorId: 1,
      sizeId: 1,
      qtyPcs: 10,
    });
    expect(packerCheck.status).toBe(400);
    expect(packerCheck.body.error).toMatch(/not a checker/i);

    const overIssue = await request(ctx.app).post('/api/checking').set('Cookie', operator).send({
      issueDate: '2026-07-06',
      staffId: 1,
      modelId: 1,
      colorId: 1,
      sizeId: 1,
      qtyPcs: 10,
    });
    expect(overIssue.status).toBe(409);
    expect(overIssue.body.error).toMatch(/available 0/);
  });

  it('incremental results: pass/reject/missing with reason breakdown', async () => {
    // session 1: 60 passed, 6 rejected (4 stitching + 2 elastic), 0 missing
    const s1 = await request(ctx.app)
      .post(`/api/checking/${checkId}/results`)
      .set('Cookie', operator)
      .send({
        resultDate: '2026-07-07',
        qtyPassed: 60,
        qtyRejected: 6,
        qtyMissing: 0,
        rejections: [
          { reason: 'stitching_issue', qtyPcs: 4 },
          { reason: 'elastic_issue', qtyPcs: 2 },
        ],
        notes: '',
      });
    expect(s1.status).toBe(201);
    expect(s1.body.status).toBe('open'); // 54 still with checker

    // breakdown must add up
    const badBreakdown = await request(ctx.app)
      .post(`/api/checking/${checkId}/results`)
      .set('Cookie', operator)
      .send({
        resultDate: '2026-07-07',
        qtyPassed: 0,
        qtyRejected: 5,
        qtyMissing: 0,
        rejections: [{ reason: 'damage', qtyPcs: 3 }],
      });
    expect(badBreakdown.status).toBe(400);
    expect(badBreakdown.body.error).toMatch(/add up/i);

    // cannot exceed what the checker holds
    const tooMuch = await request(ctx.app)
      .post(`/api/checking/${checkId}/results`)
      .set('Cookie', operator)
      .send({ resultDate: '2026-07-07', qtyPassed: 60, qtyRejected: 0, qtyMissing: 0 });
    expect(tooMuch.status).toBe(409);

    // session 2 completes: 52 passed, 0 rejected, 2 missing
    const s2 = await request(ctx.app)
      .post(`/api/checking/${checkId}/results`)
      .set('Cookie', operator)
      .send({ resultDate: '2026-07-08', qtyPassed: 52, qtyRejected: 0, qtyMissing: 2, notes: 'lost in transit' });
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
  });
});

describe('packing → finished goods → dispatch', () => {
  let packId: number;

  it('issues passed goods to a packer (role both works)', async () => {
    const checkerAsPacker = await request(ctx.app).post('/api/packing').set('Cookie', operator).send({
      issueDate: '2026-07-09',
      staffId: 1, // checker only
      modelId: 1,
      colorId: 1,
      sizeId: 1,
      qtyPcs: 10,
    });
    expect(checkerAsPacker.status).toBe(400);
    expect(checkerAsPacker.body.error).toMatch(/not a packer/i);

    const res = await request(ctx.app).post('/api/packing').set('Cookie', operator).send({
      issueDate: '2026-07-09',
      staffId: 3, // Kavita, role both — same-person checker+packer scenario
      modelId: 1,
      colorId: 1,
      sizeId: 1,
      qtyPcs: 112,
      notes: '',
    });
    expect(res.status).toBe(201);
    expect(res.body.docNo).toBe('PCK-0001');
    packId = res.body.id as number;
  });

  it('incremental pack results: packed to FG, short with reason', async () => {
    const s1 = await request(ctx.app)
      .post(`/api/packing/${packId}/results`)
      .set('Cookie', operator)
      .send({ resultDate: '2026-07-10', qtyPacked: 100, qtyShort: 0 });
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

    expect(stageTotal('FG')).toBe(110);
    expect(stageTotal('PACKING')).toBe(0);

    const fg = await request(ctx.app).get('/api/stock/FG').set('Cookie', owner);
    expect(fg.body.items[0].qty).toBe(110);
  });

  it('dispatch is admin-only, reduces FG, void restores it', async () => {
    const asOperator = await request(ctx.app).post('/api/dispatches').set('Cookie', operator).send({
      dispatchDate: '2026-07-11',
      modelId: 1,
      colorId: 1,
      sizeId: 1,
      qtyPcs: 24,
    });
    expect(asOperator.status).toBe(403);

    const res = await request(ctx.app).post('/api/dispatches').set('Cookie', admin).send({
      dispatchDate: '2026-07-11',
      modelId: 1,
      colorId: 1,
      sizeId: 1,
      qtyPcs: 24,
      notes: 'sold to Delhi shop',
    });
    expect(res.status).toBe(201);
    expect(stageTotal('FG')).toBe(86);

    const tooMany = await request(ctx.app).post('/api/dispatches').set('Cookie', admin).send({
      dispatchDate: '2026-07-11',
      modelId: 1,
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
    expect(stageTotal('FG')).toBe(110);
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
    expect(stageTotal('PACKING')).toBe(0);
    expect(stageTotal('FG')).toBe(110);
    expect(stageTotal('REJECTED')).toBe(6);
    // 110 + 6 = 116 = 120 - 4 ✓ zero drift

    // RAW conservation separately (cm units)
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
    expect(stageTotal('RAW')).toBe(4000); // 10000 bought − 6000 cut
  });
});
