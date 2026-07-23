import { describe, expect, it } from 'vitest';
import express, { Router } from '../../../client/src/local/shims/express';

/**
 * The Android app runs the real route files against this router instead of Express.
 * If its semantics drift, RBAC middleware could be skipped or a param guard bypassed —
 * so the behaviours the routes depend on are pinned here explicitly.
 */

type Json = Record<string, unknown>;

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  return app;
}

async function call(
  app: ReturnType<typeof makeApp>,
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Json; text: string }> {
  const raw = body === undefined ? undefined : new TextEncoder().encode(JSON.stringify(body));
  const res = await app.handleRequest({
    method,
    url,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    rawBody: raw,
  });
  const text = res.body ? new TextDecoder().decode(res.body) : '';
  let json: Json = {};
  try {
    json = JSON.parse(text) as Json;
  } catch {
    /* non-JSON response */
  }
  return { status: res.status, json, text };
}

describe('express shim — routing', () => {
  it('matches literal paths, params and method', async () => {
    const app = makeApp();
    const router = Router();
    router.get('/', (_req, res) => res.json({ list: true }));
    router.get('/:id', (req, res) => res.json({ id: req.params.id }));
    router.post('/:id/void', (req, res) => res.status(201).json({ voided: req.params.id }));
    app.use('/api/purchases', router);

    expect((await call(app, 'GET', '/api/purchases')).json).toEqual({ list: true });
    expect((await call(app, 'GET', '/api/purchases/42')).json).toEqual({ id: '42' });
    const voided = await call(app, 'POST', '/api/purchases/42/void', {});
    expect(voided.status).toBe(201);
    expect(voided.json).toEqual({ voided: '42' });
    // wrong method on an existing path is a 404, never a silent match
    expect((await call(app, 'DELETE', '/api/purchases/42')).status).toBe(404);
  });

  it('does not let a param match across a path separator', async () => {
    const app = makeApp();
    const router = Router();
    router.get('/:id', (req, res) => res.json({ id: req.params.id }));
    app.use('/api/jobs', router);
    expect((await call(app, 'GET', '/api/jobs/1/receipts')).status).toBe(404);
  });

  it('runs router.param guards before the handler', async () => {
    const app = makeApp();
    const router = Router();
    const seen: string[] = [];
    router.param('id', (_req, res, next, value) => {
      seen.push(value);
      if (!/^\d+$/.test(value)) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      next();
    });
    router.get('/:id', (_req, res) => res.json({ reached: true }));
    app.use('/api/x', router);

    expect((await call(app, 'GET', '/api/x/7')).json).toEqual({ reached: true });
    const bad = await call(app, 'GET', '/api/x/abc');
    expect(bad.status).toBe(404);
    expect(bad.json).toEqual({ error: 'Not found' });
    expect(seen).toEqual(['7', 'abc']);
  });

  it('stops the chain when middleware responds without calling next', async () => {
    const app = makeApp();
    const router = Router();
    const deny = (_req: never, res: { status: (c: number) => { json: (b: unknown) => unknown } }) =>
      res.status(403).json({ error: 'You do not have permission for this action.' });
    let handlerRan = false;
    router.post('/', deny as never, (_req, res) => {
      handlerRan = true;
      return res.json({ created: true });
    });
    app.use('/api/masters', router);

    const res = await call(app, 'POST', '/api/masters', { name: 'x' });
    expect(res.status).toBe(403);
    expect(handlerRan).toBe(false);
  });

  it('exposes the remaining path to a mounted router (wildcard serving)', async () => {
    const app = makeApp();
    const router = Router();
    router.get('/{*splat}', (req, res) => res.json({ path: req.path, splat: req.params.splat }));
    app.use('/uploads', router);

    expect((await call(app, 'GET', '/uploads/2026-07/abc.webp')).json).toEqual({
      path: '/2026-07/abc.webp',
      splat: '2026-07/abc.webp',
    });
  });

  it('parses the query string and decodes params', async () => {
    const app = makeApp();
    const router = Router();
    router.get('/:key', (req, res) => res.json({ key: req.params.key, q: req.query }));
    app.use('/api/settings', router);

    const res = await call(app, 'GET', '/api/settings/delayed%20days?from=2026-01-01&to=2026-02-01');
    expect(res.json).toEqual({
      key: 'delayed days',
      q: { from: '2026-01-01', to: '2026-02-01' },
    });
  });
});

describe('express shim — bodies, errors and responses', () => {
  it('parses JSON bodies and rejects malformed ones with a 400', async () => {
    const app = makeApp();
    const router = Router();
    router.post('/', (req, res) => res.json({ echoed: req.body }));
    app.use('/api/echo', router);
    app.use((err: unknown, _req: unknown, res: never, _next: unknown) => {
      const status = (err as { status?: number }).status ?? 500;
      (res as unknown as { status: (c: number) => { json: (b: unknown) => void } })
        .status(status)
        .json({ error: 'Invalid request body.' });
    });

    expect((await call(app, 'POST', '/api/echo', { a: 1 })).json).toEqual({ echoed: { a: 1 } });

    const broken = await app.handleRequest({
      method: 'POST',
      url: '/api/echo',
      headers: { 'content-type': 'application/json' },
      rawBody: new TextEncoder().encode('{not json'),
    });
    expect(broken.status).toBe(400);
  });

  it('sends a thrown error and a rejected promise to the error handler', async () => {
    const app = makeApp();
    const router = Router();
    router.get('/sync', () => {
      throw new Error('sync boom');
    });
    router.get('/async', async () => {
      await Promise.resolve();
      throw new Error('async boom');
    });
    app.use('/api/fail', router);
    app.use((err: unknown, _req: unknown, res: never, _next: unknown) => {
      (res as unknown as { status: (c: number) => { json: (b: unknown) => void } })
        .status(500)
        .json({ error: (err as Error).message });
    });

    expect((await call(app, 'GET', '/api/fail/sync')).json).toEqual({ error: 'sync boom' });
    expect((await call(app, 'GET', '/api/fail/async')).json).toEqual({ error: 'async boom' });
  });

  it('serves binary bodies with the headers that were set', async () => {
    const app = makeApp();
    const router = Router();
    router.get('/photo', (_req, res) => {
      res.setHeader('Content-Type', 'image/webp');
      res.setHeader('Cache-Control', 'private, max-age=2592000, immutable');
      return res.send(new Uint8Array([1, 2, 3, 4]));
    });
    app.use('/uploads', router);

    const res = await app.handleRequest({ method: 'GET', url: '/uploads/photo' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['cache-control']).toContain('immutable');
    expect([...(res.body ?? [])]).toEqual([1, 2, 3, 4]);
  });

  it('round-trips a session cookie the way the auth routes use it', async () => {
    const app = makeApp();
    const router = Router();
    router.post('/login', (_req, res) => {
      res.cookie('bharti_session', 'token123', { httpOnly: true, sameSite: 'lax', secure: true });
      return res.json({ ok: true });
    });
    router.get('/me', (req, res) => res.json({ token: req.cookies['bharti_session'] ?? null }));
    app.use('/api/auth', router);
    // cookie-parser is mounted by app.core in the real app
    const cookieParser = (await import('../../../client/src/local/shims/cookie-parser')).default;
    const app2 = makeApp();
    app2.use(cookieParser() as never);
    app2.use('/api/auth', router);

    const login = await app.handleRequest({ method: 'POST', url: '/api/auth/login' });
    expect(login.headers['set-cookie']).toContain('bharti_session=token123');
    expect(login.headers['set-cookie']).toContain('HttpOnly');

    const me = await app2.handleRequest({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: 'bharti_session=token123' },
    });
    expect(JSON.parse(new TextDecoder().decode(me.body!))).toEqual({ token: 'token123' });
  });

  it('answers unknown paths with a 404 rather than hanging', async () => {
    const app = makeApp();
    app.use('/api', ((_req: unknown, res: unknown) => {
      (res as { status: (c: number) => { json: (b: unknown) => void } })
        .status(404)
        .json({ error: 'Not found' });
    }) as never);
    expect((await call(app, 'GET', '/api/nope')).status).toBe(404);
    expect((await call(app, 'GET', '/totally/unknown')).status).toBe(404);
  });
});
