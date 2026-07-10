import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { makeTestContext, type TestContext } from '../helpers';

let ctx: TestContext;

beforeAll(async () => {
  process.env.LOGIN_MAX_PER_MINUTE = '3';
  ctx = await makeTestContext();
});
afterAll(() => {
  ctx.cleanup();
  process.env.LOGIN_MAX_PER_MINUTE = '100000';
});

describe('login rate limiting', () => {
  it('returns 429 after the per-minute budget', async () => {
    const attempt = () =>
      request(ctx.app).post('/api/auth/login').send({ username: 'admin', password: 'wrong' });
    for (let i = 0; i < 3; i++) {
      expect((await attempt()).status).toBe(401);
    }
    expect((await attempt()).status).toBe(429);
  });
});
