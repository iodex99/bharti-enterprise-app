import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { loginAs, makeTestContext, type TestContext } from '../helpers';

/**
 * Automatic updates (ADR-043) wait for the office to go quiet before restarting the
 * server, so that nobody loses a half-typed form. "Quiet" is measured from real user
 * requests — which means the screens that refresh themselves on a timer must NOT count.
 *
 * This is the test that keeps the feature honest: a dashboard or stock page left open
 * on a desk polls every 60 seconds for ever. If those polls counted as activity, the
 * office would never look idle and updates would silently never install — the exact
 * failure the feature exists to remove.
 */

let ctx: TestContext;
let admin: string;
let activity: typeof import('../../src/services/activity');

/** Pretend nobody has touched the system for ten minutes. */
function goQuiet(): void {
  activity.setLastActivityForTest(Date.now() - 10 * 60 * 1000);
}

beforeAll(async () => {
  ctx = await makeTestContext();
  admin = await loginAs(ctx.app, 'admin', 'Admin@123');
  // Imported AFTER makeTestContext so this is the same module instance the app uses
  // (the helper calls vi.resetModules()).
  activity = await import('../../src/services/activity');
});
afterAll(() => ctx.cleanup());

describe('what counts as somebody working', () => {
  const backgroundPolls = [
    '/api/system/health',
    '/api/system/update-status',
    '/api/system/update-check',
    '/api/dashboard',
    '/api/dashboard/alerts',
    '/api/stock/summary',
  ];

  for (const path of backgroundPolls) {
    it(`${path} does not reset the idle clock`, async () => {
      goQuiet();
      await request(ctx.app).get(path).set('Cookie', admin);
      expect(activity.idleSeconds()).toBeGreaterThan(500);
    });
  }

  it('a real page request does reset it', async () => {
    goQuiet();
    expect(activity.idleSeconds()).toBeGreaterThan(500);
    await request(ctx.app).get('/api/masters/colors').set('Cookie', admin);
    expect(activity.idleSeconds()).toBeLessThan(5);
  });

  it('saving something resets it', async () => {
    goQuiet();
    await request(ctx.app)
      .post('/api/masters/colors')
      .set('Cookie', admin)
      .send({ name: 'Idle Test Colour' });
    expect(activity.idleSeconds()).toBeLessThan(5);
  });

  it('an unauthenticated request never counts — signed-out noise is not work', async () => {
    goQuiet();
    await request(ctx.app).get('/api/masters/colors'); // no cookie -> 401
    expect(activity.idleSeconds()).toBeGreaterThan(500);
  });
});

describe('the admin can steer automatic updates', () => {
  it('exposes the setting, defaulting to on', async () => {
    const res = await request(ctx.app).get('/api/system/settings').set('Cookie', admin);
    expect(res.status).toBe(200);
    expect(res.body.settings.auto_update).toBe('on');
    expect(res.body.settings.auto_update_idle_minutes).toBe('3');
  });

  it('accepts on/off and a quiet period, and rejects nonsense', async () => {
    const put = (key: string, value: string) =>
      request(ctx.app).put('/api/system/settings').set('Cookie', admin).send({ key, value });

    expect((await put('auto_update', 'off')).status).toBe(200);
    expect((await put('auto_update_idle_minutes', '15')).status).toBe(200);
    expect((await put('auto_update', 'maybe')).status).toBe(400);
    expect((await put('auto_update_idle_minutes', '0')).status).toBe(400);

    const res = await request(ctx.app).get('/api/system/settings').set('Cookie', admin);
    expect(res.body.settings.auto_update).toBe('off');
    expect(res.body.settings.auto_update_idle_minutes).toBe('15');
  });
});
