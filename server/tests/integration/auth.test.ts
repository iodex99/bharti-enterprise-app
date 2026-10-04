import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { loginAs, makeTestContext, type TestContext } from '../helpers';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await makeTestContext();
});
afterAll(() => ctx.cleanup());

describe('auth', () => {
  it('rejects wrong credentials with a generic message', async () => {
    const res = await request(ctx.app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'nope' });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid username or password/i);

    const unknown = await request(ctx.app)
      .post('/api/auth/login')
      .send({ username: 'ghost', password: 'nope' });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error).toBe(res.body.error); // no username probing
  });

  it('logs in and serves /me', async () => {
    const cookie = await loginAs(ctx.app, 'admin', 'Admin@123');
    const me = await request(ctx.app).get('/api/auth/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body.user.username).toBe('admin');
    expect(me.body.user.role).toBe('admin');
  });

  it('writes an audit row for login', () => {
    const row = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'login'")
      .get() as { n: number };
    expect(row.n).toBeGreaterThan(0);
  });

  it('validates the login body', async () => {
    const res = await request(ctx.app).post('/api/auth/login').send({ username: 'admin' });
    expect(res.status).toBe(400);
  });

  it('locks the account after 5 wrong passwords', async () => {
    ctx.db
      .prepare(
        `INSERT INTO users (username, password_hash, display_name, role, must_change_password)
         VALUES ('locky', (SELECT password_hash FROM users WHERE username='admin'), 'Locky', 'operator', 0)`,
      )
      .run();
    for (let i = 0; i < 5; i++) {
      await request(ctx.app).post('/api/auth/login').send({ username: 'locky', password: 'wrong' });
    }
    const locked = await request(ctx.app)
      .post('/api/auth/login')
      .send({ username: 'locky', password: 'Admin@123' });
    expect(locked.status).toBe(423);
  });

  it('logout revokes the session', async () => {
    const cookie = await loginAs(ctx.app, 'operator', 'Operator@123');
    await request(ctx.app).post('/api/auth/logout').set('Cookie', cookie);
    const me = await request(ctx.app).get('/api/auth/me').set('Cookie', cookie);
    expect(me.status).toBe(401);
  });

  it('change-password enforces strength and revokes other sessions', async () => {
    const cookieA = await loginAs(ctx.app, 'owner', 'Owner@123');
    const cookieB = await loginAs(ctx.app, 'owner', 'Owner@123');

    const weak = await request(ctx.app)
      .post('/api/auth/change-password')
      .set('Cookie', cookieA)
      .send({ currentPassword: 'Owner@123', newPassword: 'short' });
    expect(weak.status).toBe(400);

    const wrongCurrent = await request(ctx.app)
      .post('/api/auth/change-password')
      .set('Cookie', cookieA)
      .send({ currentPassword: 'nope', newPassword: 'NewPass123' });
    expect(wrongCurrent.status).toBe(400);

    const ok = await request(ctx.app)
      .post('/api/auth/change-password')
      .set('Cookie', cookieA)
      .send({ currentPassword: 'Owner@123', newPassword: 'NewPass123' });
    expect(ok.status).toBe(200);

    // Session A (the one that changed it) survives; B is revoked.
    expect((await request(ctx.app).get('/api/auth/me').set('Cookie', cookieA)).status).toBe(200);
    expect((await request(ctx.app).get('/api/auth/me').set('Cookie', cookieB)).status).toBe(401);

    // New password works.
    const cookieC = await loginAs(ctx.app, 'owner', 'NewPass123');
    expect((await request(ctx.app).get('/api/auth/me').set('Cookie', cookieC)).status).toBe(200);
  });

  it('rejects cross-origin mutations (CSRF guard)', async () => {
    const res = await request(ctx.app)
      .post('/api/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ username: 'admin', password: 'Admin@123' });
    expect(res.status).toBe(403);
  });

  // Phones reach the office PC through `tailscale serve`, an HTTPS reverse proxy. Should a
  // proxy rewrite Host to the backend's localhost address, the browser's real host only
  // survives in X-Forwarded-Host — and every sign-in would otherwise be rejected.
  it('accepts a same-origin mutation that arrives through a reverse proxy', async () => {
    const res = await request(ctx.app)
      .post('/api/auth/login')
      .set('Host', 'localhost:8787')
      .set('X-Forwarded-Host', 'office-pc.tail1a2b3c.ts.net')
      .set('X-Forwarded-Proto', 'https')
      .set('Origin', 'https://office-pc.tail1a2b3c.ts.net')
      .send({ username: 'admin', password: 'Admin@123' });
    expect(res.status).toBe(200);
  });

  it('still rejects a foreign origin even when a forwarded host is present', async () => {
    const res = await request(ctx.app)
      .post('/api/auth/login')
      .set('Host', 'localhost:8787')
      .set('X-Forwarded-Host', 'office-pc.tail1a2b3c.ts.net')
      .set('Origin', 'https://evil.example')
      .send({ username: 'admin', password: 'Admin@123' });
    expect(res.status).toBe(403);
  });

  it('garbage session cookie is just anonymous', async () => {
    const res = await request(ctx.app)
      .get('/api/auth/me')
      .set('Cookie', 'bharti_session=deadbeef');
    expect(res.status).toBe(401);
  });
});
