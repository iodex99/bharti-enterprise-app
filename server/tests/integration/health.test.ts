import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';

describe('GET /api/system/health', () => {
  it('reports ok with a version', async () => {
    const app = createApp();
    const res = await request(app).get('/api/system/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.version).toBe('string');
  });

  it('unknown api routes return JSON 404', async () => {
    const app = createApp();
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
  });
});
