import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestContext, type TestContext } from '../helpers';
import type { Movement } from '../../src/services/ledger.service';

/**
 * Conservation invariant suite — the rules that make the ledger trustworthy.
 */
let ctx: TestContext;
let post: (movements: Movement[]) => void;
let ledger: typeof import('../../src/services/ledger.service');

beforeAll(async () => {
  ctx = await makeTestContext();
  ledger = await import('../../src/services/ledger.service');
  // masters rows the FK constraints need
  ctx.db.exec(`
    INSERT INTO models (id, code, name, created_by) VALUES (1, 'M1', 'Model 1', 1);
    INSERT INTO colors (id, name, created_by) VALUES (1, 'Black', 1);
    INSERT INTO sizes (id, code, created_by) VALUES (1, 'XS', 1);
    INSERT INTO contractors (id, name, created_by) VALUES (1, 'C1', 1);
    INSERT INTO vendors (id, name, created_by) VALUES (1, 'V1', 1);
    INSERT INTO purchases (id, doc_no, purchase_date, received_date, vendor_id, model_id, color_id,
      qty_cm, rate_paise_per_meter, total_paise, created_by)
      VALUES (1, 'RM-0001', '2026-07-01', '2026-07-01', 1, 1, 1, 10000, 0, 0, 1);
  `);
  post = (movements) => {
    const tx = ctx.db.transaction(() => ledger.postMovements(ctx.db, movements, 1));
    tx();
  };
});
afterAll(() => ctx.cleanup());

const raw = (qty: number, refType = 'purchase', refId = 1): Movement => ({
  stage: 'RAW',
  modelId: 1,
  colorId: 1,
  sizeId: null,
  lotType: 'purchase',
  lotId: 1,
  qty,
  refType: refType as Movement['refType'],
  refId,
});

const cut = (qty: number, refType: string, refId: number, lotId = 1): Movement => ({
  stage: 'CUT',
  modelId: 1,
  colorId: 1,
  sizeId: 1,
  lotType: 'cutting_line',
  lotId,
  qty,
  refType: refType as Movement['refType'],
  refId,
});

describe('ledger conservation rules', () => {
  it('refuses to run outside a transaction', () => {
    expect(() => ledger.postMovements(ctx.db, [raw(100)], 1)).toThrow(/inside a db.transaction/);
  });

  it('genesis creates stock; balances reflect it', () => {
    post([raw(10000)]);
    const lots = ledger.availableLots(ctx.db, { stage: 'RAW', modelId: 1, colorId: 1 });
    expect(lots).toHaveLength(1);
    expect(lots[0]!.qty).toBe(10000);
  });

  it('genesis types cannot remove stock', () => {
    expect(() => post([raw(-1)])).toThrow(/may only create/);
  });

  it('terminal types cannot create stock', () => {
    expect(() => post([raw(5, 'dispatch', 9)])).toThrow(/may only remove/);
  });

  it('zero and fractional quantities are rejected', () => {
    expect(() => post([raw(0)])).toThrow(/non-zero integer/);
    expect(() => post([raw(1.5)])).toThrow(/non-zero integer/);
  });

  it('RAW must not carry a size; other stages must', () => {
    expect(() => post([{ ...raw(10), sizeId: 1 }])).toThrow(/size is not allowed/);
    expect(() => post([{ ...cut(10, 'cutting_output', 1), sizeId: null }])).toThrow(/size is required/);
  });

  it('unbalanced transfers are rejected', () => {
    expect(() =>
      post([
        { ...cut(-5, 'job_issue', 1) }, // out of CUT with no matching +5 into WIP
      ]),
    ).toThrow(/does not balance/);
  });

  it('overdraw is rejected at lot level', () => {
    // consume more RAW than exists (have 10000)
    expect(() => post([raw(-20000, 'cutting_consume', 1)])).toThrow(/Not enough stock/);
    // exact draw is fine
    post([raw(-4000, 'cutting_consume', 1)]);
    const lots = ledger.availableLots(ctx.db, { stage: 'RAW', modelId: 1, colorId: 1 });
    expect(lots[0]!.qty).toBe(6000);
  });

  it('grouped outgoing rows validate against the combined total', () => {
    // two -4000 draws when only 6000 remains must fail as a pair
    expect(() =>
      post([raw(-4000, 'cutting_consume', 2), raw(-4000, 'cutting_consume', 3)]),
    ).toThrow(/Not enough stock/);
  });

  it('balanced transfer moves stock between stages', () => {
    ctx.db.exec(`
      INSERT INTO cutting_batches (id, doc_no, cut_date, raw_lot_type, raw_lot_id, model_id, color_id, meters_used_cm, status, created_by)
      VALUES (1, 'CUT-0001', '2026-07-02', 'purchase', 1, 1, 1, 1000, 'completed', 1);
      INSERT INTO cutting_lines (id, cutting_batch_id, size_id, expected_pcs, actual_pcs)
      VALUES (1, 1, 1, 120, 120);
      INSERT INTO job_cards (id, doc_no, issue_date, contractor_id, model_id, color_id, created_by)
      VALUES (1, 'JOB-0001', '2026-07-03', 1, 1, 1, 1);
      INSERT INTO job_card_lines (id, job_card_id, size_id, qty_issued_pcs)
      VALUES (1, 1, 1, 50);
    `);
    post([cut(120, 'cutting_output', 1)]);
    post([
      cut(-50, 'job_issue', 1),
      {
        stage: 'WIP',
        modelId: 1,
        colorId: 1,
        sizeId: 1,
        contractorId: 1,
        lotType: 'job_line',
        lotId: 1,
        qty: 50,
        refType: 'job_issue',
        refId: 1,
      },
    ]);
    const cutLots = ledger.availableLots(ctx.db, { stage: 'CUT', modelId: 1, colorId: 1, sizeId: 1 });
    const wipLots = ledger.availableLots(ctx.db, { stage: 'WIP', modelId: 1, colorId: 1, sizeId: 1 });
    expect(cutLots[0]!.qty).toBe(70);
    expect(wipLots[0]!.qty).toBe(50);
  });

  it('a failed batch rolls back atomically (no partial rows)', () => {
    const before = (
      ctx.db.prepare('SELECT COUNT(*) AS n FROM stock_ledger').get() as { n: number }
    ).n;
    expect(() =>
      post([
        cut(-10, 'check_issue', 5),
        {
          stage: 'CHECKING',
          modelId: 1,
          colorId: 1,
          sizeId: 1,
          lotType: 'receipt_line',
          lotId: 999,
          qty: 5, // unbalanced on purpose (net -5)
          refType: 'check_issue',
          refId: 5,
        },
      ]),
    ).toThrow(/does not balance/);
    const after = (
      ctx.db.prepare('SELECT COUNT(*) AS n FROM stock_ledger').get() as { n: number }
    ).n;
    expect(after).toBe(before);
  });

  it('stockByDimensions groups correctly', () => {
    const rows = ledger.stockByDimensions(ctx.db, 'CUT');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.qty).toBe(70);
    expect(rows[0]!.modelCode).toBe('M1');
  });
});
