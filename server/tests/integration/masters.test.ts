import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { loginAs, makeTestContext, type TestContext } from '../helpers';

let ctx: TestContext;
let admin: string;
let operator: string;
let owner: string;

beforeAll(async () => {
  ctx = await makeTestContext();
  admin = await loginAs(ctx.app, 'admin', 'Admin@123');
  operator = await loginAs(ctx.app, 'operator', 'Operator@123');
  owner = await loginAs(ctx.app, 'owner', 'Owner@123');
});
afterAll(() => ctx.cleanup());

/** One create payload per master, used to loop the shared behaviors. */
const SAMPLES: Record<string, Record<string, unknown>> = {
  models: { code: 'SCR-01', name: 'Velvet Scrunchie', description: 'test' },
  colors: { name: 'Crimson', colorCode: '#DC143C' },
  sizes: { code: 'M1', description: 'Medium', sortOrder: 3 },
  vendors: { name: 'Test Vendor', gstin: '07AAACS1234A1Z5', mobile: '9812345678' },
  contractors: { name: 'Test Contractor', defaultRatePaisePerDozen: 3000 },
  staff: { name: 'Test Checker', role: 'checker' },
};

describe.each(Object.entries(SAMPLES))('master %s', (master, sample) => {
  it('full lifecycle: create → list → update → deactivate → reactivate → delete', async () => {
    const create = await request(ctx.app)
      .post(`/api/masters/${master}`)
      .set('Cookie', admin)
      .send(sample);
    expect(create.status).toBe(201);
    const id = create.body.id as number;

    // duplicate rejected, case-insensitive
    const dupPayload = { ...sample };
    const uniqueKey = 'code' in sample ? 'code' : 'name';
    dupPayload[uniqueKey] = String(sample[uniqueKey]).toUpperCase();
    const dup = await request(ctx.app)
      .post(`/api/masters/${master}`)
      .set('Cookie', admin)
      .send(dupPayload);
    expect(dup.status).toBe(409);

    // owner can read
    const list = await request(ctx.app).get(`/api/masters/${master}`).set('Cookie', owner);
    expect(list.status).toBe(200);
    expect(list.body.items.some((i: { id: number }) => i.id === id)).toBe(true);

    // search works
    const q = String(sample[uniqueKey]).slice(0, 4);
    const search = await request(ctx.app)
      .get(`/api/masters/${master}?q=${encodeURIComponent(q)}`)
      .set('Cookie', admin);
    expect(search.body.items.length).toBeGreaterThan(0);

    // update
    const upd = await request(ctx.app)
      .put(`/api/masters/${master}/${id}`)
      .set('Cookie', admin)
      .send(sample);
    expect(upd.status).toBe(200);

    // deactivate hides from default list, includeInactive shows it
    await request(ctx.app).post(`/api/masters/${master}/${id}/deactivate`).set('Cookie', admin);
    const activeOnly = await request(ctx.app).get(`/api/masters/${master}`).set('Cookie', admin);
    expect(activeOnly.body.items.some((i: { id: number }) => i.id === id)).toBe(false);
    const withInactive = await request(ctx.app)
      .get(`/api/masters/${master}?includeInactive=1`)
      .set('Cookie', admin);
    expect(withInactive.body.items.some((i: { id: number }) => i.id === id)).toBe(true);

    await request(ctx.app).post(`/api/masters/${master}/${id}/reactivate`).set('Cookie', admin);

    // soft delete (no references yet) removes from all lists
    const del = await request(ctx.app).delete(`/api/masters/${master}/${id}`).set('Cookie', admin);
    expect(del.status).toBe(200);
    const afterDelete = await request(ctx.app)
      .get(`/api/masters/${master}?includeInactive=1`)
      .set('Cookie', admin);
    expect(afterDelete.body.items.some((i: { id: number }) => i.id === id)).toBe(false);
    // row still exists in the DB (soft delete only)
    const raw = ctx.db.prepare(`SELECT deleted_at FROM ${master} WHERE id = ?`).get(id) as {
      deleted_at: string | null;
    };
    expect(raw.deleted_at).not.toBeNull();
  });

  it('operator cannot mutate, owner cannot mutate', async () => {
    for (const cookie of [operator, owner]) {
      const res = await request(ctx.app)
        .post(`/api/masters/${master}`)
        .set('Cookie', cookie)
        .send(sample);
      expect(res.status).toBe(403);
    }
  });
});

describe('masters validation & referential rules', () => {
  it('rejects invalid payloads with a useful message', async () => {
    const bad = await request(ctx.app)
      .post('/api/masters/colors')
      .set('Cookie', admin)
      .send({ name: 'Bad', colorCode: 'red' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/RRGGBB/);

    const badGst = await request(ctx.app)
      .post('/api/masters/vendors')
      .set('Cookie', admin)
      .send({ name: 'GST Vendor', gstin: 'SHORT' });
    expect(badGst.status).toBe(400);
  });

  it('blocks soft delete when referenced, suggests deactivation', async () => {
    // build a model + color + vendor + a purchase referencing them
    const mk = async (master: string, payload: Record<string, unknown>) =>
      (await request(ctx.app).post(`/api/masters/${master}`).set('Cookie', admin).send(payload))
        .body.id as number;
    const modelId = await mk('models', { code: 'REF-M', name: 'Ref Model' });
    const colorId = await mk('colors', { name: 'Ref Color' });
    const vendorId = await mk('vendors', { name: 'Ref Vendor' });
    ctx.db
      .prepare(
        `INSERT INTO purchases (doc_no, purchase_date, received_date, vendor_id, model_id, color_id,
         qty_cm, rate_paise_per_meter, total_paise, created_by)
         VALUES ('RM-9999', '2026-07-01', '2026-07-02', ?, ?, ?, 10000, 5000, 500000, 1)`,
      )
      .run(vendorId, modelId, colorId);

    for (const [master, id] of [
      ['models', modelId],
      ['colors', colorId],
      ['vendors', vendorId],
    ] as const) {
      const del = await request(ctx.app).delete(`/api/masters/${master}/${id}`).set('Cookie', admin);
      expect(del.status).toBe(409);
      expect(del.body.error).toMatch(/deactivate/i);
    }
  });

  it('unknown master path 404s', async () => {
    const res = await request(ctx.app).get('/api/masters/unicorns').set('Cookie', admin);
    expect(res.status).toBe(404);
  });

  it('the RAW-CLOTH sentinel model is never listed, even with includeInactive', async () => {
    const res = await request(ctx.app)
      .get('/api/masters/models?includeInactive=1')
      .set('Cookie', admin);
    expect(res.status).toBe(200);
    expect(
      (res.body.items as Array<{ code?: string }>).some((m) => m.code === 'RAW-CLOTH'),
    ).toBe(false);
  });

  it('staff can be created without a role (any staff checks or packs)', async () => {
    const res = await request(ctx.app)
      .post('/api/masters/staff')
      .set('Cookie', admin)
      .send({ name: 'Rolefree Staff', mobile: '' });
    expect(res.status).toBe(201);
  });
});

describe('uploads', () => {
  // 1x1 red PNG
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  it('accepts an image from operator, converts to webp, serves behind auth', async () => {
    const up = await request(ctx.app)
      .post('/api/uploads')
      .set('Cookie', operator)
      .attach('image', png, 'photo.png');
    expect(up.status).toBe(201);
    expect(up.body.path).toMatch(/^\/uploads\/\d{4}-\d{2}\/[0-9a-f]{16}\.webp$/);

    const anon = await request(ctx.app).get(up.body.path as string);
    expect(anon.status).toBe(401);
    const authed = await request(ctx.app).get(up.body.path as string).set('Cookie', owner);
    expect(authed.status).toBe(200);
    expect(authed.headers['content-type']).toMatch(/webp|octet-stream/);
  });

  it('rejects non-images and owners', async () => {
    const junk = await request(ctx.app)
      .post('/api/uploads')
      .set('Cookie', operator)
      .attach('image', Buffer.from('not an image'), 'x.png');
    expect(junk.status).toBe(400);

    const asOwner = await request(ctx.app)
      .post('/api/uploads')
      .set('Cookie', owner)
      .attach('image', png, 'photo.png');
    expect(asOwner.status).toBe(403);
  });

  it('path traversal in /uploads is blocked', async () => {
    const res = await request(ctx.app)
      .get('/uploads/..%2F..%2Fapp.db')
      .set('Cookie', admin);
    expect([400, 404]).toContain(res.status);
  });
});
