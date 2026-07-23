import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { loginAs, makeTestContext, type TestContext } from '../helpers';

/**
 * Discrepancy review workflow: list with source-document context, admin-only
 * resolve (acknowledgement — never a stock movement), audit trail.
 */
let ctx: TestContext;
let admin: string;
let operator: string;
let owner: string;

beforeAll(async () => {
  ctx = await makeTestContext();
  admin = await loginAs(ctx.app, 'admin', 'Admin@123');
  operator = await loginAs(ctx.app, 'operator', 'Operator@123');
  owner = await loginAs(ctx.app, 'owner', 'Owner@123');
  ctx.db.exec(`
    INSERT INTO models (id, code, name, created_by) VALUES (1, 'M1', 'Model 1', 1);
    INSERT INTO colors (id, name, created_by) VALUES (1, 'Black', 1);
    INSERT INTO sizes (id, code, sort_order, created_by) VALUES (1, 'XS', 1, 1), (2, 'S1', 2, 1);
    INSERT INTO vendors (id, name, created_by) VALUES (1, 'V1', 1);
  `);
  const purchase = await request(ctx.app).post('/api/purchases').set('Cookie', operator).send({
    purchaseDate: '2026-07-01',
    receivedDate: '2026-07-01',
    vendorId: 1,
    colorId: 1,
    qtyCm: 20000,
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
      modelId: 1,
      notes: '',
      lines: [
        { sizeId: 1, expectedPcs: 120, clothPerPcInchC: 1000, widthCount: 3 },
        { sizeId: 2, expectedPcs: 60, clothPerPcInchC: 1200, widthCount: 2 },
      ],
    });
  // XS: -12 (wastage), S1: +12 (better yield) -> two CUT discrepancies
  await request(ctx.app)
    .post(`/api/cutting/${plan.body.id}/actuals`)
    .set('Cookie', operator)
    .send({
      lines: [
        { sizeId: 1, actualPcs: 108, varianceReason: 'wastage', reasonNote: 'edge damage' },
        { sizeId: 2, actualPcs: 72, varianceReason: 'better_yield' },
      ],
    });
});
afterAll(() => ctx.cleanup());

type Row = {
  id: number;
  stage: string;
  docNo: string | null;
  item: string | null;
  qtyPcs: number;
  reason: string;
  resolvedAt: string | null;
  resolvedByName: string | null;
  resolutionNote: string;
};

const list = async (cookie: string): Promise<Row[]> => {
  const res = await request(ctx.app).get('/api/discrepancies').set('Cookie', cookie);
  expect(res.status).toBe(200);
  return res.body.items as Row[];
};

describe('discrepancies', () => {
  it('lists rows with source-document context, unresolved first', async () => {
    const items = await list(owner); // owner may review
    expect(items).toHaveLength(2);
    const short = items.find((r) => r.qtyPcs === -12)!;
    const extra = items.find((r) => r.qtyPcs === 12)!;
    expect(short.stage).toBe('CUT');
    expect(short.docNo).toBe('CUT-0001');
    expect(short.item).toBe('M1 Black XS');
    expect(short.reason).toBe('wastage');
    expect(short.resolvedAt).toBeNull();
    expect(extra.item).toBe('M1 Black S1');
    expect(extra.reason).toBe('better_yield');
  });

  it('resolve is admin-only and validated', async () => {
    const [row] = await list(admin);
    const asOperator = await request(ctx.app)
      .post(`/api/discrepancies/${row!.id}/resolve`)
      .set('Cookie', operator)
      .send({ note: 'operator trying' });
    expect(asOperator.status).toBe(403);
    const asOwner = await request(ctx.app)
      .post(`/api/discrepancies/${row!.id}/resolve`)
      .set('Cookie', owner)
      .send({ note: 'owner trying' });
    expect(asOwner.status).toBe(403);
    const anon = await request(ctx.app).post(`/api/discrepancies/${row!.id}/resolve`).send({ note: 'anon' });
    expect(anon.status).toBe(401);
    const tooShort = await request(ctx.app)
      .post(`/api/discrepancies/${row!.id}/resolve`)
      .set('Cookie', admin)
      .send({ note: 'x' });
    expect(tooShort.status).toBe(400);
    const missing = await request(ctx.app)
      .post('/api/discrepancies/99999/resolve')
      .set('Cookie', admin)
      .send({ note: 'does not exist' });
    expect(missing.status).toBe(404);
    const garbageId = await request(ctx.app)
      .post('/api/discrepancies/1e9x/resolve')
      .set('Cookie', admin)
      .send({ note: 'garbage id' });
    expect(garbageId.status).toBe(404);
  });

  it('admin resolves: acknowledgement recorded + audited, stock untouched, no double-resolve', async () => {
    const ledgerBefore = (ctx.db.prepare('SELECT COUNT(*) AS n FROM stock_ledger').get() as { n: number }).n;
    const target = (await list(admin)).find((r) => r.qtyPcs === -12)!;

    const res = await request(ctx.app)
      .post(`/api/discrepancies/${target.id}/resolve`)
      .set('Cookie', admin)
      .send({ note: 'confirmed wastage — register corrected' });
    expect(res.status).toBe(200);

    const after = (await list(admin)).find((r) => r.id === target.id)!;
    expect(after.resolvedAt).not.toBeNull();
    expect(after.resolvedByName).toBe('Admin');
    expect(after.resolutionNote).toBe('confirmed wastage — register corrected');
    // resolved rows sort after unresolved ones
    expect((await list(admin))[0]!.resolvedAt).toBeNull();

    // acknowledgement only — the ledger must not move
    const ledgerAfter = (ctx.db.prepare('SELECT COUNT(*) AS n FROM stock_ledger').get() as { n: number }).n;
    expect(ledgerAfter).toBe(ledgerBefore);

    const auditRow = ctx.db
      .prepare(
        `SELECT new_json FROM audit_log
         WHERE action = 'discrepancy_resolve' AND entity_type = 'discrepancy' AND entity_id = ?`,
      )
      .get(target.id) as { new_json: string } | undefined;
    expect(auditRow).toBeDefined();
    expect(JSON.parse(auditRow!.new_json).resolutionNote).toMatch(/confirmed wastage/);

    const again = await request(ctx.app)
      .post(`/api/discrepancies/${target.id}/resolve`)
      .set('Cookie', admin)
      .send({ note: 'trying twice' });
    expect(again.status).toBe(409);
  });

  it('dashboard alert for unresolved discrepancies points at the discrepancies page', async () => {
    const res = await request(ctx.app).get('/api/dashboard/alerts').set('Cookie', owner);
    expect(res.status).toBe(200);
    const alert = (res.body.items as Array<{ title: string; link: string }>).find((a) =>
      /unresolved CUT discrepanc/.test(a.title),
    );
    expect(alert).toBeDefined();
    expect(alert!.link).toBe('/discrepancies');
  });
});
