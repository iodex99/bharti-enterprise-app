import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { loginAs, makeTestContext, type TestContext } from '../helpers';

/**
 * Multi-office isolation (ADR-028). Two offices run the same kind of business side by
 * side; NOTHING of one may be visible or reachable from the other. This suite drives
 * both offices through the whole chain and then attacks every read and write across
 * the boundary — including by guessing the other office's document ids, which is the
 * only interesting attack an authenticated user has.
 */
let ctx: TestContext;
let admin: string;
let hoOperator: string;
let brOperator: string;
let owner: string;
let BR = 0;

/** Admin/owner pick their office per request; operators are pinned server-side. */
const asOffice = (req: request.Test, cookie: string, officeId: number) =>
  req.set('Cookie', cookie).set('X-Office-Id', String(officeId));

type Chain = { purchaseId: number; cuttingId: number; jobId: number; checkId: number; packId: number; discrepancyId: number };

/** Runs purchase -> cut -> job -> receipt -> check(with a 'missing') -> pack in one office. */
async function buildChain(cookie: string, officeId: number, code: string): Promise<Chain> {
  const post = (url: string, body: unknown) =>
    asOffice(request(ctx.app).post(url), cookie, officeId).send(body as object);
  const must = async (p: request.Test, what: string) => {
    const res = await p;
    if (res.status >= 400) throw new Error(`${what} failed (office ${officeId}): ${res.text}`);
    return res;
  };

  const purchase = await must(
    post('/api/purchases', {
      purchaseDate: '2026-07-01',
      receivedDate: '2026-07-01',
      vendorId: 1,
      colorId: 1,
      lenInchC: 180000,
      widthInchC: 4400,
      ratePaisePerYard: 4000,
      notes: '',
    }),
    'purchase',
  );
  const cutting = await must(
    post('/api/cutting', {
      cutDate: '2026-07-02',
      rawLotType: 'purchase',
      rawLotId: purchase.body.id,
      notes: '',
      lines: [{ sizeId: 1, code, qtyPcs: 120, clothPerPcInchC: 1000, widthCount: 3 }],
    }),
    'cutting',
  );
  const modelId = (ctx.db.prepare('SELECT id FROM models WHERE code = ?').get(code) as { id: number }).id;
  const job = await must(
    post('/api/jobs', {
      issueDate: '2026-07-03',
      contractorId: 1,
      notes: '',
      lines: [{ modelId, colorId: 1, sizeId: 1, qtyIssuedPcs: 120, unitEntered: 'dozens', ratePaisePerDozen: 3000 }],
    }),
    'job',
  );
  const jobId = job.body.cards[0].id as number;
  const lineId = (
    ctx.db.prepare('SELECT id FROM job_card_lines WHERE job_card_id = ?').get(jobId) as { id: number }
  ).id;
  const receipt = await must(
    post(`/api/jobs/${jobId}/receipts`, {
      receiptDate: '2026-07-05',
      imagePath: '/uploads/2026-07/r.webp',
      lines: [{ jobCardLineId: lineId, qtyPcs: 120, returnType: 'stitched' }],
    }),
    'receipt',
  );
  const receiptLineId = (
    ctx.db.prepare('SELECT id FROM job_receipt_lines WHERE job_receipt_id = ?').get(receipt.body.id) as { id: number }
  ).id;
  const check = await must(
    post('/api/checking', {
      issueDate: '2026-07-06',
      staffId: 1,
      lotType: 'receipt_line',
      lotId: receiptLineId,
      qtyPcs: 120,
      notes: '',
    }),
    'check issue',
  );
  await must(
    post(`/api/checking/${check.body.id}/results`, {
      resultDate: '2026-07-07',
      qtyPassed: 108,
      rejections: [{ reason: 'missing', qtyPcs: 12 }], // -> a discrepancy in THIS office
      notes: '',
    }),
    'check result',
  );
  const pack = await must(
    post(`/api/checking/${check.body.id}/pack`, {
      issueDate: '2026-07-08',
      staffId: 1,
      qtyPcs: 108,
      kind: 'pack',
      label: '',
      notes: '',
    }),
    'pack issue',
  );
  await must(
    post(`/api/packing/${pack.body.id}/results`, { resultDate: '2026-07-09', qtyPacked: 108, qtyShort: 0 }),
    'pack result',
  );
  const discrepancyId = (
    ctx.db
      .prepare('SELECT id FROM discrepancies WHERE office_id = ? ORDER BY id DESC LIMIT 1')
      .get(officeId) as { id: number }
  ).id;

  return { purchaseId: purchase.body.id, cuttingId: cutting.body.id, jobId, checkId: check.body.id, packId: pack.body.id, discrepancyId };
}

let ho: Chain;
let br: Chain;

beforeAll(async () => {
  ctx = await makeTestContext();
  admin = await loginAs(ctx.app, 'admin', 'Admin@123');
  owner = await loginAs(ctx.app, 'owner', 'Owner@123');
  hoOperator = await loginAs(ctx.app, 'operator', 'Operator@123'); // pinned to office 1

  ctx.db.exec(`
    INSERT INTO colors (id, name, created_by) VALUES (1, 'Black', 1);
    INSERT INTO sizes (id, code, sort_order, created_by) VALUES (1, 'HR', 1, 1);
    INSERT INTO vendors (id, name, created_by) VALUES (1, 'V1', 1);
    INSERT INTO contractors (id, name, default_rate_paise_per_dozen, created_by) VALUES (1, 'Meena', 3000, 1);
    INSERT INTO staff (id, name, role, default_rate_paise_per_dozen, created_by) VALUES (1, 'Pooja', 'both', 300, 1);
  `);

  // a second office + an operator pinned to it
  const office = await request(ctx.app)
    .post('/api/offices')
    .set('Cookie', admin)
    .send({ code: 'BR', name: 'Branch Office' });
  expect(office.status).toBe(201);
  BR = office.body.id as number;
  const brUser = await request(ctx.app)
    .post('/api/users')
    .set('Cookie', admin)
    .send({ username: 'brop', displayName: 'Branch Op', role: 'operator', password: 'Branch@123', officeId: BR });
  expect(brUser.status).toBe(201);
  brOperator = await loginAs(ctx.app, 'brop', 'Branch@123');

  ho = await buildChain(hoOperator, 1, 'HO-1');
  br = await buildChain(brOperator, BR, 'BR-1');
}, 60_000);
afterAll(() => ctx.cleanup());

describe('document numbering per office', () => {
  it('office 1 keeps plain numbers; the branch prefixes its own series', () => {
    const hoDoc = ctx.db.prepare('SELECT doc_no FROM purchases WHERE id = ?').get(ho.purchaseId) as { doc_no: string };
    const brDoc = ctx.db.prepare('SELECT doc_no FROM purchases WHERE id = ?').get(br.purchaseId) as { doc_no: string };
    expect(hoDoc.doc_no).toBe('RM-0001');
    expect(brDoc.doc_no).toBe('BR-RM-0001'); // its own counter, and globally unique
  });
});

describe('an operator sees only their own office', () => {
  const listsThatMustNotLeak = [
    '/api/purchases',
    '/api/cutting',
    '/api/jobs',
    '/api/checking',
    '/api/checking/pending',
    '/api/packing',
    '/api/discrepancies',
    '/api/trace/fg-lots',
  ];

  it('every list returns exactly one office worth of rows', async () => {
    for (const url of listsThatMustNotLeak) {
      const hoRes = await request(ctx.app).get(url).set('Cookie', hoOperator);
      const brRes = await request(ctx.app).get(url).set('Cookie', brOperator);
      expect(hoRes.status, url).toBe(200);
      expect(brRes.status, url).toBe(200);
      const body = JSON.stringify(hoRes.body);
      const brBody = JSON.stringify(brRes.body);
      // the branch's code never appears in head office's data, and vice versa
      expect(body, `${url} leaked BR data to HO`).not.toContain('BR-1');
      expect(brBody, `${url} leaked HO data to BR`).not.toContain('HO-1');
      expect(brBody, `${url} leaked HO doc numbers to BR`).not.toMatch(/"RM-0001"/);
    }
  });

  it('the X-Office-Id header cannot move a pinned operator to another office', async () => {
    const res = await asOffice(request(ctx.app).get('/api/purchases'), hoOperator, BR);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('BR-RM-0001'); // header ignored for operators
  });

  it('stock is per office: each office holds only what it produced', async () => {
    const hoFg = await request(ctx.app).get('/api/stock/FG').set('Cookie', hoOperator);
    const brFg = await request(ctx.app).get('/api/stock/FG').set('Cookie', brOperator);
    expect(JSON.stringify(hoFg.body)).toContain('HO-1');
    expect(JSON.stringify(hoFg.body)).not.toContain('BR-1');
    expect(JSON.stringify(brFg.body)).toContain('BR-1');
    expect(JSON.stringify(brFg.body)).not.toContain('HO-1');
  });
});

describe('guessing the other office document ids gets nothing', () => {
  it('reads: trace refuses another office batch (this is how FG lineage used to leak)', async () => {
    const own = await request(ctx.app).get(`/api/trace/fg/${ho.packId}`).set('Cookie', hoOperator);
    expect(own.status).toBe(200);
    const across = await request(ctx.app).get(`/api/trace/fg/${br.packId}`).set('Cookie', hoOperator);
    expect(across.status).toBe(404);

    const ownPurchase = await request(ctx.app).get(`/api/trace/purchase/${ho.purchaseId}`).set('Cookie', hoOperator);
    expect(ownPurchase.status).toBe(200);
    const acrossPurchase = await request(ctx.app)
      .get(`/api/trace/purchase/${br.purchaseId}`)
      .set('Cookie', hoOperator);
    expect(acrossPurchase.status).toBe(404);
  });

  it('reads: job receipts of another office are not served', async () => {
    const own = await request(ctx.app).get(`/api/jobs/${ho.jobId}/receipts`).set('Cookie', hoOperator);
    expect(own.body.items.length).toBeGreaterThan(0);
    const across = await request(ctx.app).get(`/api/jobs/${br.jobId}/receipts`).set('Cookie', hoOperator);
    expect(across.body.items).toHaveLength(0);
  });

  it('writes: every void/edit refuses a document from the other office', async () => {
    const attempts: Array<[string, object]> = [
      [`/api/purchases/${br.purchaseId}/void`, { reason: 'cross-office attempt' }],
      [`/api/cutting/${br.cuttingId}/void`, { reason: 'cross-office attempt' }],
      [`/api/jobs/${br.jobId}/void`, { reason: 'cross-office attempt' }],
      [`/api/checking/${br.checkId}/void`, { reason: 'cross-office attempt' }],
      [`/api/packing/${br.packId}/void`, { reason: 'cross-office attempt' }],
    ];
    for (const [url, body] of attempts) {
      // admin explicitly working in office 1
      const res = await asOffice(request(ctx.app).post(url), admin, 1).send(body);
      expect(res.status, url).toBe(404);
    }
    // and the branch's documents are still intact
    const stillThere = ctx.db
      .prepare('SELECT voided_at FROM purchases WHERE id = ?')
      .get(br.purchaseId) as { voided_at: string | null };
    expect(stillThere.voided_at).toBeNull();
  });

  it("writes: resolving another office's discrepancy is refused", async () => {
    const across = await asOffice(request(ctx.app).post(`/api/discrepancies/${br.discrepancyId}/resolve`), admin, 1)
      .send({ note: 'resolving a branch row from head office' });
    expect(across.status).toBe(404);
    const row = ctx.db
      .prepare('SELECT resolved_at FROM discrepancies WHERE id = ?')
      .get(br.discrepancyId) as { resolved_at: string | null };
    expect(row.resolved_at).toBeNull();

    // the same admin CAN resolve it once actually working in that office
    const inOffice = await asOffice(request(ctx.app).post(`/api/discrepancies/${br.discrepancyId}/resolve`), admin, BR)
      .send({ note: 'reviewed in the branch' });
    expect(inOffice.status).toBe(200);
  });

  it('writes: results cannot be recorded against another office issue', async () => {
    const res = await asOffice(request(ctx.app).post(`/api/checking/${br.checkId}/results`), admin, 1).send({
      resultDate: '2026-07-10',
      qtyPassed: 1,
      rejections: [],
      notes: '',
    });
    expect(res.status).toBe(404);
  });

  it('writes: cutting cannot consume a raw lot belonging to another office', async () => {
    const res = await asOffice(request(ctx.app).post('/api/cutting'), admin, 1).send({
      cutDate: '2026-07-11',
      rawLotType: 'purchase',
      rawLotId: br.purchaseId, // the branch's cloth
      notes: '',
      lines: [{ sizeId: 1, code: 'THIEF', qtyPcs: 12, clothPerPcInchC: 1000, widthCount: 3 }],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('admin and owner switch offices with the header', () => {
  it('the same admin sees each office in turn, and never both at once', async () => {
    const inHo = await asOffice(request(ctx.app).get('/api/purchases'), admin, 1);
    expect(JSON.stringify(inHo.body)).toContain('RM-0001');
    expect(JSON.stringify(inHo.body)).not.toContain('BR-RM-0001');

    const inBr = await asOffice(request(ctx.app).get('/api/purchases'), admin, BR);
    expect(JSON.stringify(inBr.body)).toContain('BR-RM-0001');
    expect(JSON.stringify(inBr.body)).not.toMatch(/"RM-0001"/);
  });

  it('money is per office: dues and staff pay do not pool across offices', async () => {
    const hoDues = await asOffice(request(ctx.app).get('/api/contractors/dues'), owner, 1);
    const brDues = await asOffice(request(ctx.app).get('/api/contractors/dues'), owner, BR);
    expect(hoDues.body.totalDuesPaise).toBeGreaterThan(0);
    expect(brDues.body.totalDuesPaise).toBeGreaterThan(0);
    // each office owes for its own 120 pcs only — identical work, so identical dues
    expect(hoDues.body.totalDuesPaise).toBe(brDues.body.totalDuesPaise);

    const hoStaff = await asOffice(request(ctx.app).get('/api/staff/dues'), owner, 1);
    const brStaff = await asOffice(request(ctx.app).get('/api/staff/dues'), owner, BR);
    expect(hoStaff.body.totalDuesPaise).toBe(brStaff.body.totalDuesPaise);
    // and a payment in one office does not settle the other
    await asOffice(request(ctx.app).post('/api/staff/payments'), admin, 1).send({
      staffId: 1,
      paymentDate: '2026-07-12',
      amountPaise: 500,
      mode: 'cash',
      reference: '',
      notes: '',
    });
    const hoAfter = await asOffice(request(ctx.app).get('/api/staff/dues'), owner, 1);
    const brAfter = await asOffice(request(ctx.app).get('/api/staff/dues'), owner, BR);
    expect(hoAfter.body.totalDuesPaise).toBe(hoStaff.body.totalDuesPaise - 500);
    expect(brAfter.body.totalDuesPaise).toBe(brStaff.body.totalDuesPaise); // untouched
  });

  it('reports and the dashboard are office-scoped', async () => {
    const hoReport = await asOffice(request(ctx.app).get('/api/reports/cutting-register'), owner, 1);
    const brReport = await asOffice(request(ctx.app).get('/api/reports/cutting-register'), owner, BR);
    expect(JSON.stringify(hoReport.body)).toContain('HO-1');
    expect(JSON.stringify(hoReport.body)).not.toContain('BR-1');
    expect(JSON.stringify(brReport.body)).toContain('BR-1');
    expect(JSON.stringify(brReport.body)).not.toContain('HO-1');

    const hoDash = await asOffice(request(ctx.app).get('/api/dashboard'), owner, 1);
    const brDash = await asOffice(request(ctx.app).get('/api/dashboard'), owner, BR);
    expect(hoDash.body.kpis.fgPcs).toBe(108);
    expect(brDash.body.kpis.fgPcs).toBe(108); // each office counts only itself
  });

  it('an unknown or deactivated office is refused', async () => {
    // a bad office in the header is a bad request (400); an operator with no usable
    // office is a permissions problem (403) — see resolveOffice
    const unknown = await asOffice(request(ctx.app).get('/api/purchases'), admin, 9999);
    expect(unknown.status).toBe(400);

    await request(ctx.app).put(`/api/offices/${BR}`).set('Cookie', admin).send({ code: 'BR', name: 'Branch Office', isActive: false });
    const deactivated = await asOffice(request(ctx.app).get('/api/purchases'), admin, BR);
    expect(deactivated.status).toBe(400);
    // its pinned operator is locked out too, rather than silently falling back to office 1
    const pinnedOut = await request(ctx.app).get('/api/purchases').set('Cookie', brOperator);
    expect(pinnedOut.status).toBe(403);

    await request(ctx.app).put(`/api/offices/${BR}`).set('Cookie', admin).send({ code: 'BR', name: 'Branch Office', isActive: true });
  });

  it('office 1 can never be deactivated (it is the fallback for admin/owner)', async () => {
    const res = await request(ctx.app)
      .put('/api/offices/1')
      .set('Cookie', admin)
      .send({ code: 'HO', name: 'Main Office', isActive: false });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('conservation holds across offices', () => {
  it('the whole-business reconciliation stays green with two offices running', async () => {
    const res = await request(ctx.app).get('/api/system/reconciliation').set('Cookie', admin);
    expect(res.status).toBe(200);
    expect(res.body.ok, JSON.stringify(res.body.checks)).toBe(true);
  });
});
