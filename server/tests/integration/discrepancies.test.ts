import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { loginAs, makeTestContext, type TestContext } from '../helpers';

/**
 * Discrepancy review workflow: list with source-document context, admin-only
 * resolve (acknowledgement — never a stock movement), audit trail.
 * v2: discrepancies come from job shortages and checking 'missing' — the cutting
 * plan is final (ADR-031) so there is no cutting variance any more.
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
    INSERT INTO colors (id, name, created_by) VALUES (1, 'Black', 1);
    INSERT INTO sizes (id, code, sort_order, created_by) VALUES (1, 'XS', 1, 1);
    INSERT INTO vendors (id, name, created_by) VALUES (1, 'V1', 1);
    INSERT INTO contractors (id, name, default_rate_paise_per_dozen, created_by) VALUES (1, 'Meena', 3000, 1);
    INSERT INTO staff (id, name, role, created_by) VALUES (1, 'Pooja', 'checker', 1);
  `);
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
  const cut = await request(ctx.app)
    .post('/api/cutting')
    .set('Cookie', operator)
    .send({
      cutDate: '2026-07-02',
      rawLotType: 'purchase',
      rawLotId: purchase.body.id,
      notes: '',
      lines: [{ sizeId: 1, code: 'M1', qtyPcs: 240, clothPerPcInchC: 1000, widthCount: 3 }],
    });
  if (cut.status !== 201) throw new Error(`fixture cutting failed: ${cut.text}`);
  const modelM1 = (ctx.db.prepare("SELECT id FROM models WHERE code = 'M1'").get() as { id: number })
    .id;

  // job: issue 120, receive only 108, admin closes with discrepancy → WIP −12 (wastage)
  const job = await request(ctx.app)
    .post('/api/jobs')
    .set('Cookie', operator)
    .send({
      issueDate: '2026-07-03',
      contractorId: 1,
      notes: '',
      lines: [
        { modelId: modelM1, colorId: 1, sizeId: 1, qtyIssuedPcs: 120, unitEntered: 'dozens', ratePaisePerDozen: 3000 },
      ],
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
      lines: [{ jobCardLineId: lineId, qtyPcs: 108, returnType: 'stitched' }],
    });
  const closed = await request(ctx.app)
    .post(`/api/jobs/${jobCardId}/close`)
    .set('Cookie', admin)
    .send({ reason: 'wastage', note: 'edge damage at contractor' });
  if (closed.status !== 200) throw new Error(`fixture close failed: ${closed.text}`);

  // checking: issue the 108, record 6 as 'missing' → CHECKING −6 discrepancy
  const receiptLineId = (
    ctx.db
      .prepare('SELECT id FROM job_receipt_lines WHERE job_receipt_id = ?')
      .get(receipt.body.id) as { id: number }
  ).id;
  const check = await request(ctx.app).post('/api/checking').set('Cookie', operator).send({
    issueDate: '2026-07-06',
    staffId: 1,
    lotType: 'receipt_line',
    lotId: receiptLineId,
    qtyPcs: 108,
    notes: '',
  });
  const result = await request(ctx.app)
    .post(`/api/checking/${check.body.id}/results`)
    .set('Cookie', operator)
    .send({
      resultDate: '2026-07-07',
      qtyPassed: 102,
      rejections: [{ reason: 'missing', qtyPcs: 6 }],
      notes: 'bag count came up short',
    });
  if (result.status !== 201) throw new Error(`fixture check result failed: ${result.text}`);
});
afterAll(() => ctx.cleanup());

type Row = {
  id: number;
  stage: string;
  docNo: string | null;
  party: string;
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
    const missing = items.find((r) => r.qtyPcs === -6)!;
    expect(short.stage).toBe('WIP');
    expect(short.docNo).toBe('JOB-0001');
    expect(short.party).toBe('Meena'); // which contractor lost the goods
    expect(short.item).toBe('M1 Black XS');
    expect(short.reason).toBe('wastage');
    expect(short.resolvedAt).toBeNull();
    expect(missing.stage).toBe('CHECKING');
    expect(missing.docNo).toBe('CHK-0001');
    expect(missing.party).toContain('Pooja'); // which checker reported the shortfall
    expect(missing.item).toBe('M1 Black XS');
    expect(missing.reason).toBe('missing');
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
      /unresolved.*discrepanc/i.test(a.title),
    );
    expect(alert).toBeDefined();
    expect(alert!.link).toBe('/discrepancies');
  });
});
