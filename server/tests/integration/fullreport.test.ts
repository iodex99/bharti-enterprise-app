import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { loginAs, makeTestContext, type TestContext } from '../helpers';
import { REPORTS } from '../../src/services/reports.service';

let ctx: TestContext;
let owner: string;
let admin: string;
let operator: string;

beforeAll(async () => {
  ctx = await makeTestContext();
  admin = await loginAs(ctx.app, 'admin', 'Admin@123');
  operator = await loginAs(ctx.app, 'operator', 'Operator@123');
  owner = await loginAs(ctx.app, 'owner', 'Owner@123');
  ctx.db.exec(`
    INSERT INTO colors (id, name, created_by) VALUES (1, 'Black', 1);
    INSERT INTO sizes (id, code, created_by) VALUES (1, 'XS', 1);
    INSERT INTO vendors (id, name, created_by) VALUES (1, 'Vendor & Sons <fine>', 1);
  `);
  await request(ctx.app).post('/api/purchases').set('Cookie', operator).send({
    purchaseDate: '2026-07-01',
    receivedDate: '2026-07-01',
    vendorId: 1,
    colorId: 1,
    lenInchC: 360000, // 100 yd
    widthInchC: 4400,
    ratePaisePerYard: 4000,
    notes: '',
  });
});
afterAll(() => ctx.cleanup());

describe('Complete Business Report', () => {
  it('HTML: self-contained, escaped, contains every report section', async () => {
    const res = await request(ctx.app).get('/api/reports/full?format=html').set('Cookie', owner);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['content-disposition']).toMatch(/business-report-.*\.html/);
    const html = res.text;
    expect(html).toContain('Complete Business Report');
    for (const report of REPORTS) {
      // titles are HTML-escaped in the document (& -> &#38;)
      expect(html).toContain(report.title.replace(/&/g, '&#38;'));
    }
    // HTML-escaping: the vendor name with & and <> must not inject markup
    expect(html).not.toContain('<fine>');
    expect(html).toContain('&#60;fine&#62;');
    // self-contained: no external scripts or stylesheets
    expect(html).not.toMatch(/<script src=|<link rel="stylesheet"/);
    // raw stock table carries the purchase (yards, v2)
    expect(html).toContain('100 yd');
  });

  it('XLSX: one sheet per report plus the summary', async () => {
    const res = await request(ctx.app)
      .get('/api/reports/full?format=xlsx')
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
    expect(workbook.worksheets.length).toBe(REPORTS.length + 1);
    expect(workbook.worksheets[0]!.name).toBe('Summary');
    expect(workbook.worksheets[0]!.getCell(1, 1).value).toContain('Complete Business Report');
    const sheetNames = workbook.worksheets.map((s) => s.name);
    expect(sheetNames).toContain('Raw Material Stock');
    expect(sheetNames).toContain('Loss & Wastage (all stages)');
  });

  it('respects the date filter and requires auth', async () => {
    const res = await request(ctx.app)
      .get('/api/reports/full?format=html&from=2030-01-01')
      .set('Cookie', owner);
    expect(res.text).toContain('No data for this period');
    expect((await request(ctx.app).get('/api/reports/full')).status).toBe(401);
  });
});

describe('cloud backup mirror', () => {
  it('mirrors backups into the configured folder and prunes', async () => {
    const cloudDir = path.join(ctx.dir, 'fake-drive');

    const noConfig = await request(ctx.app).post('/api/system/backups/sync').set('Cookie', admin);
    expect(noConfig.status).toBe(400);
    expect(noConfig.body.error).toMatch(/no cloud backup folder/i);

    const save = await request(ctx.app)
      .put('/api/system/settings')
      .set('Cookie', admin)
      .send({ key: 'cloud_backup_dir', value: cloudDir });
    expect(save.status).toBe(200);

    // making a backup mirrors it automatically
    await request(ctx.app).post('/api/system/backups').set('Cookie', admin);
    const files = fs.readdirSync(cloudDir).filter((f) => f.endsWith('.db'));
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^manual-/);

    // explicit sync copies nothing new but succeeds
    const sync = await request(ctx.app).post('/api/system/backups/sync').set('Cookie', admin);
    expect(sync.status).toBe(200);
    expect(sync.body.copied).toBe(0);
    expect(sync.body.total).toBe(1);

    // backups listing exposes the configured folder
    const listing = await request(ctx.app).get('/api/system/backups').set('Cookie', admin);
    expect(listing.body.cloudDir).toBe(cloudDir);

    // turning it off stops mirroring
    await request(ctx.app)
      .put('/api/system/settings')
      .set('Cookie', admin)
      .send({ key: 'cloud_backup_dir', value: '' });
    await request(ctx.app).post('/api/system/backups').set('Cookie', admin);
    expect(fs.readdirSync(cloudDir).filter((f) => f.endsWith('.db')).length).toBe(1);
  });

  it('sync is admin-only', async () => {
    expect(
      (await request(ctx.app).post('/api/system/backups/sync').set('Cookie', operator)).status,
    ).toBe(403);
  });
});
