import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import sharp from 'sharp';
import request, { type Response as SuperResponse } from 'supertest';
import { loginAs, makeTestContext, type TestContext } from '../helpers';

/**
 * Complete backup (snapshot) + migration/restore. The snapshot bundles the database AND
 * uploaded photos; restore swaps ALL data atomically with an automatic rollback on failure.
 */
let ctx: TestContext;
let admin: string;
let operator: string;

/** supertest downloads binary bodies as a Buffer only with an explicit parser. */
function binaryParser(res: SuperResponse, cb: (err: Error | null, body: Buffer) => void): void {
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
  stream.on('end', () => cb(null, Buffer.concat(chunks)));
}

async function tinyPng(): Promise<Buffer> {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: '#abcdef' } }).png().toBuffer();
}

beforeAll(async () => {
  ctx = await makeTestContext();
  admin = await loginAs(ctx.app, 'admin', 'Admin@123');
  operator = await loginAs(ctx.app, 'operator', 'Operator@123');
});
afterAll(() => ctx.cleanup());

describe('first-run setup gate', () => {
  it('flags a brand-new install and clears once dismissed', async () => {
    const fresh = await request(ctx.app).get('/api/system/setup-state').set('Cookie', admin);
    expect(fresh.body.needsSetup).toBe(true);

    // operators may read it but not dismiss it
    expect((await request(ctx.app).get('/api/system/setup-state').set('Cookie', operator)).status).toBe(200);
    expect((await request(ctx.app).post('/api/system/setup/complete').set('Cookie', operator)).status).toBe(403);

    const done = await request(ctx.app).post('/api/system/setup/complete').set('Cookie', admin);
    expect(done.status).toBe(200);
    const after = await request(ctx.app).get('/api/system/setup-state').set('Cookie', admin);
    expect(after.body.needsSetup).toBe(false);
  });
});

describe('complete backup + restore', () => {
  let snapshotZip: Buffer;
  let pathA = '';
  let pathB = '';

  it('downloads a complete backup with the database + photos + manifest', async () => {
    // seed real data: masters, one purchase, one uploaded photo
    ctx.db.exec(`
      INSERT INTO models (id, code, name, created_by) VALUES (1, 'M1', 'Model 1', 1);
      INSERT INTO colors (id, name, created_by) VALUES (1, 'Black', 1);
      INSERT INTO vendors (id, name, created_by) VALUES (1, 'V1', 1);
    `);
    await request(ctx.app).post('/api/purchases').set('Cookie', admin).send({
      purchaseDate: '2026-07-01', receivedDate: '2026-07-01', vendorId: 1, modelId: 1, colorId: 1,
      qtyCm: 10000, ratePaisePerMeter: 4000, notes: 'in the snapshot',
    });
    const up = await request(ctx.app).post('/api/uploads').set('Cookie', admin).attach('image', await tinyPng(), 'billA.png');
    pathA = up.body.path as string;
    expect(pathA).toMatch(/^\/uploads\//);

    const res = await request(ctx.app)
      .get('/api/system/backups/complete')
      .set('Cookie', admin)
      .buffer()
      .parse(binaryParser);
    expect(res.status).toBe(200);
    snapshotZip = res.body as Buffer;

    // the zip really contains the manifest, database and the photo
    const zip = new AdmZip(snapshotZip);
    const manifest = JSON.parse(zip.readAsText('manifest.json')) as { kind: string; counts: { purchases: number; uploads: number } };
    expect(manifest.kind).toBe('complete-backup');
    expect(manifest.counts.purchases).toBe(1);
    expect(manifest.counts.uploads).toBe(1);
    expect(zip.getEntry('app.db')).toBeTruthy();
    expect(zip.getEntries().some((e) => e.entryName.startsWith('uploads/'))).toBe(true);
  });

  it('restore rewinds ALL data and photos to the snapshot, atomically', async () => {
    // diverge from the snapshot: a second purchase + a second photo
    await request(ctx.app).post('/api/purchases').set('Cookie', admin).send({
      purchaseDate: '2026-07-05', receivedDate: '2026-07-05', vendorId: 1, modelId: 1, colorId: 1,
      qtyCm: 5000, ratePaisePerMeter: 4000, notes: 'AFTER the snapshot — must vanish',
    });
    const upB = await request(ctx.app).post('/api/uploads').set('Cookie', admin).attach('image', await tinyPng(), 'billB.png');
    pathB = upB.body.path as string;
    expect((await request(ctx.app).get('/api/purchases').set('Cookie', admin)).body.items).toHaveLength(2);
    expect((await request(ctx.app).get(pathB).set('Cookie', admin)).status).toBe(200);

    // upload the snapshot, inspect, then commit
    const uploaded = await request(ctx.app)
      .post('/api/system/restore/upload')
      .set('Cookie', admin)
      .attach('backup', snapshotZip, 'backup.zip');
    expect(uploaded.status).toBe(200);
    expect(uploaded.body.compatible).toBe(true);
    expect(uploaded.body.manifest.counts.purchases).toBe(1);

    const committed = await request(ctx.app)
      .post('/api/system/restore/commit')
      .set('Cookie', admin)
      .send({ token: uploaded.body.token });
    expect(committed.status).toBe(200);

    // the pre-restore session no longer resolves (database was replaced)
    expect((await request(ctx.app).get('/api/auth/me').set('Cookie', admin)).status).toBe(401);
    const admin2 = await loginAs(ctx.app, 'admin', 'Admin@123');

    // only the snapshot's purchase survives; the later one is gone
    const purchases = (await request(ctx.app).get('/api/purchases').set('Cookie', admin2)).body.items as Array<{ notes: string }>;
    expect(purchases).toHaveLength(1);
    expect(purchases[0]!.notes).toBe('in the snapshot');

    // photo A (in the snapshot) is back; photo B (added later) is gone
    expect((await request(ctx.app).get(pathA).set('Cookie', admin2)).status).toBe(200);
    expect((await request(ctx.app).get(pathB).set('Cookie', admin2)).status).toBe(404);

    // a pre-restore safety copy was kept, and the restore was audited
    const backups = (await request(ctx.app).get('/api/system/backups').set('Cookie', admin2)).body.backups as Array<{ name: string }>;
    expect(backups.some((b) => b.name.startsWith('pre-restore-'))).toBe(true);
    const auditRes = await request(ctx.app).get('/api/audit?entityType=system').set('Cookie', admin2);
    expect((auditRes.body.entries as Array<{ action: string }>).some((e) => e.action === 'data_restore')).toBe(true);

    // reconciliation stays green on the restored data
    expect((await request(ctx.app).get('/api/system/reconciliation').set('Cookie', admin2)).body.ok).toBe(true);
  });

  it('rejects a non-backup zip and a newer-version backup', async () => {
    const admin2 = await loginAs(ctx.app, 'admin', 'Admin@123');

    const junk = new AdmZip();
    junk.addFile('readme.txt', Buffer.from('not a backup'));
    const junkRes = await request(ctx.app)
      .post('/api/system/restore/upload')
      .set('Cookie', admin2)
      .attach('backup', junk.toBuffer(), 'junk.zip');
    expect(junkRes.status).toBe(400);

    // take a real snapshot and forge a migration from the future into its manifest
    const good = await request(ctx.app).get('/api/system/backups/complete').set('Cookie', admin2).buffer().parse(binaryParser);
    const zip = new AdmZip(good.body as Buffer);
    const manifest = JSON.parse(zip.readAsText('manifest.json')) as { migrations: string[] };
    manifest.migrations.push('999_from_the_future.sql');
    zip.deleteFile('manifest.json');
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)));

    const future = await request(ctx.app)
      .post('/api/system/restore/upload')
      .set('Cookie', admin2)
      .attach('backup', zip.toBuffer(), 'future.zip');
    expect(future.status).toBe(200);
    expect(future.body.compatible).toBe(false);

    // committing an incompatible backup by token must be refused
    const commit = await request(ctx.app)
      .post('/api/system/restore/commit')
      .set('Cookie', admin2)
      .send({ token: future.body.token });
    expect(commit.status).toBe(400);
  });
});
