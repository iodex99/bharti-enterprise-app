import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { loginAs, makeTestContext, type TestContext } from '../helpers';
import { REPORTS } from '../../src/services/reports.service';

/**
 * Fixture: one full v2 chain (purchase → cut → job → receipt → check → pack → dispatch)
 * so every report has data, then each report + xlsx round-trip + trace trees.
 */
let ctx: TestContext;
let operator: string;
let owner: string;
let admin: string;
let purchaseId: number;
let packIssueId: number;
let modelM1 = 0;

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
    INSERT INTO staff (id, name, role, default_rate_paise_per_dozen, created_by)
      VALUES (1, 'Pooja', 'checker', 300, 1), (2, 'Ravi', 'packer', 250, 1);
  `);

  const post = (url: string, body: unknown, cookie = operator) =>
    request(ctx.app).post(url).set('Cookie', cookie).send(body as object);
  const must = async (p: ReturnType<typeof post>, what: string) => {
    const res = await p;
    if (res.status >= 400) throw new Error(`fixture ${what} failed: ${res.text}`);
    return res;
  };

  purchaseId = (
    await must(
      post('/api/purchases', {
        purchaseDate: '2026-07-01',
        receivedDate: '2026-07-01',
        vendorId: 1,
        colorId: 1,
        lenInchC: 72000, // 20 yd
        widthInchC: 4400,
        ratePaisePerYard: 4000,
        notes: '',
      }),
      'purchase',
    )
  ).body.id;
  // cutting IS final (ADR-031): 108 pcs, 3 across → 36 strips × 1000 = 36000 inch_c
  await must(
    post('/api/cutting', {
      cutDate: '2026-07-02',
      rawLotType: 'purchase',
      rawLotId: purchaseId,
      notes: '',
      lines: [{ sizeId: 1, code: 'M1', qtyPcs: 108, clothPerPcInchC: 1000, widthCount: 3 }],
    }),
    'cutting',
  );
  modelM1 = (ctx.db.prepare("SELECT id FROM models WHERE code = 'M1'").get() as { id: number }).id;
  const job = await must(
    post('/api/jobs', {
      issueDate: '2026-07-03',
      contractorId: 1,
      notes: '',
      lines: [
        { modelId: modelM1, colorId: 1, sizeId: 1, qtyIssuedPcs: 108, unitEntered: 'dozens', ratePaisePerDozen: 3000 },
      ],
    }),
    'job',
  );
  const jobCardId = job.body.cards[0].id as number;
  const jobLineId = (
    ctx.db.prepare('SELECT id FROM job_card_lines WHERE job_card_id = ?').get(jobCardId) as {
      id: number;
    }
  ).id;
  const receipt = await must(
    post(`/api/jobs/${jobCardId}/receipts`, {
      receiptDate: '2026-07-05',
      imagePath: '/uploads/2026-07/returned.webp',
      lines: [{ jobCardLineId: jobLineId, qtyPcs: 108, returnType: 'stitched' }],
    }),
    'receipt',
  );
  const receiptLineId = (
    ctx.db
      .prepare('SELECT id FROM job_receipt_lines WHERE job_receipt_id = ?')
      .get(receipt.body.id) as { id: number }
  ).id;
  const check = await must(
    post('/api/checking', {
      issueDate: '2026-07-06',
      staffId: 1,
      lotType: 'receipt_line',
      lotId: receiptLineId,
      qtyPcs: 108,
      notes: '',
    }),
    'check issue',
  );
  // 96 pass; rejected 8 (stitching 6 + elastic 2); 'missing' is a rejection reason too (4)
  await must(
    post(`/api/checking/${check.body.id}/results`, {
      resultDate: '2026-07-07',
      qtyPassed: 96,
      rejections: [
        { reason: 'stitching_issue', qtyPcs: 6 },
        { reason: 'elastic_issue', qtyPcs: 2 },
        { reason: 'missing', qtyPcs: 4 },
      ],
      notes: '',
    }),
    'check result',
  );
  // packing is directed at the checker's passed goods (ADR-035)
  const pack = await must(
    post('/api/packing', {
      issueDate: '2026-07-08',
      staffId: 2,
      lotType: 'check_issue',
      lotId: check.body.id,
      qtyPcs: 96,
      kind: 'pack',
      notes: '',
    }),
    'pack issue',
  );
  packIssueId = pack.body.id as number;
  await must(
    post(`/api/packing/${packIssueId}/results`, {
      resultDate: '2026-07-09',
      qtyPacked: 90,
      qtyShort: 6,
      shortReason: 'damage',
    }),
    'pack result',
  );
  await must(
    post(
      '/api/dispatches',
      { dispatchDate: '2026-07-10', modelId: modelM1, colorId: 1, sizeId: 1, qtyPcs: 12, notes: '' },
      admin,
    ),
    'dispatch',
  );

  // second small batch so CUT stock, pending work and contractor discrepancies all
  // have data for their reports: cut 12 → job2 6pcs (4 received, closed short 2) →
  // job3 2pcs left open/pending. CUT keeps 4 pcs.
  await must(
    post('/api/cutting', {
      cutDate: '2026-07-04',
      rawLotType: 'purchase',
      rawLotId: purchaseId,
      notes: '',
      lines: [{ sizeId: 1, code: 'M1', qtyPcs: 12, clothPerPcInchC: 1000, widthCount: 3 }],
    }),
    'cutting 2',
  );
  const job2 = await must(
    post('/api/jobs', {
      issueDate: '2026-07-05',
      contractorId: 1,
      notes: '',
      lines: [
        { modelId: modelM1, colorId: 1, sizeId: 1, qtyIssuedPcs: 6, unitEntered: 'pieces', ratePaisePerDozen: 3000 },
      ],
    }),
    'job 2',
  );
  const job2CardId = job2.body.cards[0].id as number;
  const job2LineId = (
    ctx.db.prepare('SELECT id FROM job_card_lines WHERE job_card_id = ?').get(job2CardId) as {
      id: number;
    }
  ).id;
  await must(
    post(`/api/jobs/${job2CardId}/receipts`, {
      receiptDate: '2026-07-06',
      imagePath: '/uploads/2026-07/returned2.webp',
      lines: [{ jobCardLineId: job2LineId, qtyPcs: 4, returnType: 'stitched' }],
    }),
    'receipt 2',
  );
  await must(
    post(`/api/jobs/${job2CardId}/close`, { reason: 'missing_pieces', note: 'lost 2 pcs' }, admin),
    'job 2 close',
  );
  await must(
    post('/api/jobs', {
      issueDate: '2026-07-07',
      contractorId: 1,
      notes: '',
      lines: [
        { modelId: modelM1, colorId: 1, sizeId: 1, qtyIssuedPcs: 2, unitEntered: 'pieces', ratePaisePerDozen: 3000 },
      ],
    }),
    'job 3',
  );
});
afterAll(() => ctx.cleanup());

describe('reports registry', () => {
  it('lists all reports with columns', async () => {
    const res = await request(ctx.app).get('/api/reports').set('Cookie', owner);
    expect(res.status).toBe(200);
    expect(res.body.reports.length).toBe(REPORTS.length);
    expect(res.body.reports.length).toBeGreaterThanOrEqual(14);
  });

  for (const report of REPORTS) {
    it(`runs "${report.key}" and returns column-shaped rows`, async () => {
      const res = await request(ctx.app).get(`/api/reports/${report.key}`).set('Cookie', owner);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.rows)).toBe(true);
      expect(res.body.rows.length).toBeGreaterThan(0); // fixture feeds every report
      const keys = new Set(Object.keys(res.body.rows[0] as object));
      for (const column of report.columns) {
        expect(keys.has(column.key)).toBe(true);
      }
    });
  }

  it('unknown report 404s; anon 401s', async () => {
    expect((await request(ctx.app).get('/api/reports/nope').set('Cookie', owner)).status).toBe(404);
    expect((await request(ctx.app).get('/api/reports/losses')).status).toBe(401);
  });

  it('filters narrow results (cutting-register by date)', async () => {
    const all = await request(ctx.app).get('/api/reports/cutting-register').set('Cookie', owner);
    expect(all.body.rows.length).toBe(2); // both batches
    const one = await request(ctx.app)
      .get('/api/reports/cutting-register?to=2026-07-03')
      .set('Cookie', owner);
    expect(one.body.rows.length).toBe(1);
    const none = await request(ctx.app)
      .get('/api/reports/cutting-register?from=2030-01-01')
      .set('Cookie', owner);
    expect(none.body.rows.length).toBe(0);
  });

  it('specific numbers: losses report carries every recorded loss', async () => {
    const res = await request(ctx.app).get('/api/reports/losses').set('Cookie', owner);
    const reasons = res.body.rows.map((r: { reason: string }) => r.reason);
    expect(reasons).toContain('missing pieces'); // job2 closed 2 short
    expect(reasons.some((r: string) => r.includes('stitching'))).toBe(true); // rejection
    expect(reasons).toContain('missing'); // check missing 4
    expect(reasons).toContain('damage'); // pack short 6
  });

  it('xlsx export round-trips with title, headers and data', async () => {
    const res = await request(ctx.app)
      .get('/api/reports/fg-stock?format=xlsx')
      .set('Cookie', owner)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/spreadsheetml/);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.body as never);
    const sheet = workbook.worksheets[0]!;
    expect(sheet.getCell(1, 1).value).toBe('Finished Goods Stock');
    expect(sheet.getCell(3, 1).value).toBe('Code'); // header row after title+subtitle
    expect(sheet.getCell(4, 1).value).toBe('M1'); // first data row
    expect(sheet.getCell(4, 4).value).toBe('6dz 6pc'); // 90 packed − 12 dispatched = 78
  });
});

describe('traceability', () => {
  it('lists FG lots for the picker', async () => {
    const res = await request(ctx.app).get('/api/trace/fg-lots').set('Cookie', owner);
    expect(res.status).toBe(200);
    expect(res.body.items[0].packIssueId).toBe(packIssueId);
    expect(res.body.items[0].qtyPcs).toBe(78);
  });

  it('traces an FG batch all the way back to the vendor', async () => {
    const res = await request(ctx.app).get(`/api/trace/fg/${packIssueId}`).set('Cookie', owner);
    expect(res.status).toBe(200);
    const tree = res.body.tree as { label: string; children: unknown[] };
    expect(tree.label).toMatch(/PCK-0001/);

    // walk to the leaves and expect the vendor purchase node
    const labels: string[] = [];
    const walk = (node: { label: string; children: Array<never> }) => {
      labels.push(node.label);
      for (const child of node.children) walk(child);
    };
    walk(tree as never);
    expect(labels.some((l) => l.includes('CHK-0001'))).toBe(true);
    expect(labels.some((l) => l.includes('JOB-0001') && l.includes('Meena'))).toBe(true);
    expect(labels.some((l) => l.includes('CUT-0001'))).toBe(true);
    expect(labels.some((l) => l.includes('RM-0001') && l.includes('V1'))).toBe(true);
  });

  it('traces a purchase forward to jobs', async () => {
    const res = await request(ctx.app)
      .get(`/api/trace/purchase/${purchaseId}`)
      .set('Cookie', owner);
    expect(res.status).toBe(200);
    const json = JSON.stringify(res.body.tree);
    expect(json).toContain('CUT-0001');
    expect(json).toContain('JOB-0001');
    expect(json).toContain('Meena');
  });

  it('404s on unknown ids', async () => {
    expect((await request(ctx.app).get('/api/trace/fg/999').set('Cookie', owner)).status).toBe(404);
    expect(
      (await request(ctx.app).get('/api/trace/purchase/999').set('Cookie', owner)).status,
    ).toBe(404);
  });
});
