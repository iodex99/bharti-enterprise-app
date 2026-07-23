import { expect, test, type Page } from '@playwright/test';

/**
 * The Android app, end to end.
 *
 * These tests run the real shipped bundle in Chromium — the same engine as the Android
 * System WebView — so the whole stack is exercised as installed: SQLite compiled to
 * WebAssembly, the migrations, the Express routes running inside a worker, and the
 * update flow against a mock release feed.
 *
 * Each test gets a fresh browser context, so each one starts on a brand-new "device"
 * with no data.
 */

const APP_PORT = Number(process.env.E2E_APP_PORT ?? 8789);
const feed = (kind: 'good' | 'broken' | 'corrupt') =>
  `http://localhost:${APP_PORT}/mock-feed/${kind}/latest.json`;

type ApiResult = { status: number; body: Record<string, unknown> };

/** Call the in-app server exactly as the pages do. */
async function api(page: Page, path: string, init?: RequestInit & { json?: unknown }): Promise<ApiResult> {
  return page.evaluate(
    async ([p, method, payload]) => {
      const options: RequestInit = { method: method as string };
      if (payload !== null) {
        options.headers = { 'content-type': 'application/json' };
        options.body = JSON.stringify(payload);
      }
      const res = await fetch(p as string, options);
      const text = await res.text();
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        body = { raw: text.slice(0, 200) };
      }
      return { status: res.status, body };
    },
    [path, init?.method ?? 'GET', init?.json ?? null] as const,
  );
}

/** Boot the app and sign in as the admin this device generated on first run. */
async function bootAndSignIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForSelector('form', { timeout: 45_000 });

  const raw = await page.evaluate(() => localStorage.getItem('bharti.initialAdmin'));
  expect(raw, 'the app generates an admin password on first run').toBeTruthy();
  const { username, password } = JSON.parse(raw!) as { username: string; password: string };

  const login = await api(page, '/api/auth/login', {
    method: 'POST',
    json: { username, password },
  });
  expect(login.status).toBe(200);

  // The generated password must be changed before the app is usable.
  const changed = await api(page, '/api/auth/change-password', {
    method: 'POST',
    json: { currentPassword: password, newPassword: 'Admin@123' },
  });
  expect(changed.status).toBe(200);

  await api(page, '/api/auth/login', {
    method: 'POST',
    json: { username: 'admin', password: 'Admin@123' },
  });
}

async function seedMasters(page: Page): Promise<void> {
  for (const [path, payload] of [
    ['/api/masters/models', { code: 'SCR-VEL', name: 'Velvet Scrunchie' }],
    ['/api/masters/colors', { name: 'Maroon', colorCode: '#800000' }],
    ['/api/masters/sizes', { code: 'M', name: 'Medium', sortOrder: 1 }],
    ['/api/masters/vendors', { name: 'Kumar Textiles' }],
  ] as const) {
    const res = await api(page, path, { method: 'POST', json: payload });
    expect(res.status, `${path} -> ${JSON.stringify(res.body)}`).toBe(201);
  }
}

test.describe('the app runs the whole system on the device', () => {
  test('a brand-new device can be signed into, through the screen alone', async ({ page }) => {
    // The generated password exists nowhere else — no server, no email, no printout. If
    // the sign-in screen does not show it, the device is unusable, so this walks the
    // whole first-run path the way the owner does, touching no storage directly.
    await page.goto('/');
    await page.waitForSelector('form', { timeout: 45_000 });

    const callout = page.getByText(/This device is new/i);
    await expect(callout).toBeVisible();
    const shown = await page.locator('code').allInnerTexts();
    const [username, password] = [shown[0]!.trim(), shown[1]!.trim()];
    expect(username).toBe('admin');
    expect(password).toMatch(/^[a-f0-9]{8}$/);

    await page.getByLabel('Username').fill(username);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    // Forced straight into setting a real password.
    await expect(page.getByText(/must set a new password/i)).toBeVisible({ timeout: 20_000 });
    await page.getByLabel('Current password').fill(password);
    await page.getByLabel('New password', { exact: true }).fill('Owner@2026');
    await page.getByLabel('Confirm new password').fill('Owner@2026');
    await page.getByRole('button', { name: 'Save new password' }).click();
    await expect(page.getByText(/must set a new password/i)).toBeHidden({ timeout: 20_000 });

    // …and the one-time password stops being offered once it is worthless.
    await page.goto('/login');
    await expect(callout).toBeHidden();
  });

  test('first run creates an admin, applies migrations and records real work', async ({ page }) => {
    await bootAndSignIn(page);

    const health = await api(page, '/api/system/health');
    expect(health.body.ok).toBe(true);

    await seedMasters(page);

    const purchase = await api(page, '/api/purchases', {
      method: 'POST',
      json: {
        purchaseDate: '2026-07-01',
        receivedDate: '2026-07-01',
        vendorId: 1,
        colorId: 1,
        qtyCm: 12550,
        ratePaisePerMeter: 4000,
        notes: 'first cloth on the device',
      },
    });
    expect(purchase.status).toBe(201);

    // The ledger moved, not just a document row.
    const raw = await api(page, '/api/stock/summary');
    const stages = raw.body.stages as Array<{ stage: string; qty: number }>;
    expect(stages.find((s) => s.stage === 'RAW')?.qty).toBe(12550);

    // …and the UI shows it.
    await page.goto('/purchases');
    await expect(page.getByRole('cell', { name: 'RM-0001' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('cell', { name: 'Kumar Textiles' })).toBeVisible();
  });

  test('builds the demo business and every check passes', async ({ page }) => {
    await bootAndSignIn(page);

    const entered = await api(page, '/api/system/demo/enter?fresh=1', { method: 'POST' });
    expect(entered.status).toBe(200);

    await api(page, '/api/auth/login', {
      method: 'POST',
      json: { username: 'admin', password: 'Admin@123' },
    });

    // Three months of business driven through every service — purchases, cutting,
    // job work, checking, packing, dispatch — against SQLite in WebAssembly.
    const dashboard = await api(page, '/api/dashboard');
    const kpis = dashboard.body.kpis as Record<string, number>;
    expect(kpis.fgPcs).toBeGreaterThan(0);
    expect(kpis.rawCm).toBeGreaterThan(0);

    const reconciliation = await api(page, '/api/system/reconciliation');
    expect(reconciliation.body.ok, JSON.stringify(reconciliation.body)).toBe(true);

    const report = await api(page, '/api/reports/contractor-performance');
    expect(report.status).toBe(200);
    expect((report.body.rows as unknown[]).length).toBeGreaterThan(0);

    await page.goto('/');
    await expect(page.getByText(/DEMO MODE/i).first()).toBeVisible({ timeout: 20_000 });

    const exited = await api(page, '/api/system/demo/exit', { method: 'POST' });
    expect(exited.status).toBe(200);
  });

  test('stores a photo in the database and serves it back', async ({ page }) => {
    await bootAndSignIn(page);

    const result = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 400;
      canvas.height = 300;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#ff0066';
      context.fillRect(0, 0, 400, 300);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      const form = new FormData();
      form.append('image', new File([blob!], 'goods.png', { type: 'image/png' }));

      const upload = await fetch('/api/uploads', { method: 'POST', body: form });
      const uploaded = (await upload.json()) as { path?: string; error?: string };
      if (!upload.ok) return { uploadStatus: upload.status, error: uploaded.error };

      const served = await fetch(uploaded.path!);
      const bytes = new Uint8Array(await served.arrayBuffer());
      return {
        uploadStatus: upload.status,
        path: uploaded.path,
        servedStatus: served.status,
        contentType: served.headers.get('content-type'),
        // bytes 8..12 of a WebP file spell "WEBP"
        format: String.fromCharCode(...bytes.slice(8, 12)),
      };
    });

    expect(result.error).toBeUndefined();
    expect(result.uploadStatus).toBe(201);
    expect(result.path).toMatch(/^\/uploads\/\d{4}-\d{2}\/[a-f0-9]{16}\.webp$/);
    expect(result.servedStatus).toBe(200);
    expect(result.contentType).toBe('image/webp');
    expect(result.format).toBe('WEBP');
  });

  test('a backup captures everything and restoring rewinds to it', async ({ page }) => {
    await bootAndSignIn(page);
    await seedMasters(page);

    await api(page, '/api/purchases', {
      method: 'POST',
      json: {
        purchaseDate: '2026-07-01',
        receivedDate: '2026-07-01',
        vendorId: 1,
        colorId: 1,
        qtyCm: 10000,
        ratePaisePerMeter: 4000,
        notes: 'inside the backup',
      },
    });

    // Take the backup, then carry on working past it.
    const backup = await page.evaluate(async () => {
      const res = await fetch('/api/system/backups/complete');
      const body = (await res.json()) as { uri: string; sizeBytes: number };
      const bytes = new Uint8Array(await (await fetch(body.uri)).arrayBuffer());
      // keep the bytes on the page so the restore step can hand them back
      (window as unknown as { __backup: number[] }).__backup = [...bytes];
      return { status: res.status, sizeBytes: body.sizeBytes };
    });
    expect(backup.status).toBe(200);
    expect(backup.sizeBytes).toBeGreaterThan(1000);

    await api(page, '/api/purchases', {
      method: 'POST',
      json: {
        purchaseDate: '2026-07-05',
        receivedDate: '2026-07-05',
        vendorId: 1,
        colorId: 1,
        qtyCm: 5000,
        ratePaisePerMeter: 4000,
        notes: 'AFTER the backup — must vanish',
      },
    });
    expect(((await api(page, '/api/purchases')).body.items as unknown[]).length).toBe(2);

    const restored = await page.evaluate(async () => {
      const bytes = new Uint8Array((window as unknown as { __backup: number[] }).__backup);
      const form = new FormData();
      form.append('backup', new File([bytes], 'backup.db', { type: 'application/octet-stream' }));
      const upload = await fetch('/api/system/restore/upload', { method: 'POST', body: form });
      const staged = (await upload.json()) as { token?: string; error?: string };
      if (!upload.ok) return { uploadStatus: upload.status, error: staged.error };
      const commit = await fetch('/api/system/restore/commit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: staged.token }),
      });
      return { uploadStatus: upload.status, commitStatus: commit.status };
    });
    expect(restored.error).toBeUndefined();
    expect(restored.commitStatus).toBe(200);

    // Everyone is signed out of the replaced data, and only the backup's work survives.
    expect((await api(page, '/api/auth/me')).status).toBe(401);
    await api(page, '/api/auth/login', {
      method: 'POST',
      json: { username: 'admin', password: 'Admin@123' },
    });
    const purchases = (await api(page, '/api/purchases')).body.items as Array<{ notes: string }>;
    expect(purchases).toHaveLength(1);
    expect(purchases[0]!.notes).toBe('inside the backup');
  });

  test('rejects a file that is not one of its backups', async ({ page }) => {
    await bootAndSignIn(page);
    const rejected = await page.evaluate(async () => {
      const form = new FormData();
      form.append('backup', new File([new Uint8Array(500)], 'holiday.jpg', { type: 'image/jpeg' }));
      const res = await fetch('/api/system/restore/upload', { method: 'POST', body: form });
      return { status: res.status, body: (await res.json()) as { error?: string } };
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toMatch(/not a Bharti backup/i);
  });
});

test.describe('updating the app on the device', () => {
  /** Point the app at one of the mock releases and reload so it picks it up. */
  async function useFeed(page: Page, kind: 'good' | 'broken' | 'corrupt'): Promise<void> {
    await page.goto('/');
    await page.evaluate((url) => localStorage.setItem('bharti.updateFeed', url), feed(kind));
    await page.reload();
    await page.waitForSelector('form', { timeout: 45_000 });
  }

  type BundleState = {
    bundles: {
      active: { version: string } | null;
      previous: { version: string } | null;
      pending: { version: string; attempts: number } | null;
    } | null;
    basePath: string | null;
    rolledBackFrom: string | null;
  };

  /**
   * Applying an update restarts the app, which can destroy the page context mid-read.
   * That is the behaviour under test, so a read that lands in the restart is retried
   * rather than treated as a failure.
   */
  async function bundleState(page: Page): Promise<BundleState> {
    try {
      return await page.evaluate(() => ({
        bundles: JSON.parse(localStorage.getItem('bharti.bundles') ?? 'null') as BundleState['bundles'],
        basePath: localStorage.getItem('bharti.serverBasePath'),
        rolledBackFrom: localStorage.getItem('bharti.rolledBackFrom'),
      }));
    } catch {
      return { bundles: null, basePath: null, rolledBackFrom: null };
    }
  }

  test('downloads, verifies and installs an update — and the data is untouched', async ({ page }) => {
    await useFeed(page, 'good');
    await bootAndSignIn(page);
    await seedMasters(page);
    await api(page, '/api/purchases', {
      method: 'POST',
      json: {
        purchaseDate: '2026-07-01',
        receivedDate: '2026-07-01',
        vendorId: 1,
        colorId: 1,
        qtyCm: 7500,
        ratePaisePerMeter: 4000,
        notes: 'recorded before the update',
      },
    });

    const check = await api(page, '/api/system/update-check');
    expect(check.body.updateAvailable).toBe(true);
    expect(check.body.latest).toBe('9.9.9');
    expect(check.body.kind).toBe('bundle'); // installable without touching Android

    const started = await api(page, '/api/system/update', { method: 'POST' });
    expect(started.status).toBe(202);

    // The app writes the new bundle, activates it and restarts itself; booting
    // successfully is what promotes the pending bundle to active.
    await expect
      .poll(async () => (await bundleState(page)).bundles?.active?.version, { timeout: 60_000 })
      .toBe('9.9.9');

    // Promotion to active only happens after the restarted app has opened its database
    // and taken over fetch, so the app is serving again at this point.
    const state = await bundleState(page);
    expect(state.bundles?.pending).toBeNull();
    expect(state.basePath).toBe('/bundles/9.9.9');

    // The whole point: the business data is exactly where it was.
    await api(page, '/api/auth/login', {
      method: 'POST',
      json: { username: 'admin', password: 'Admin@123' },
    });
    const purchases = (await api(page, '/api/purchases')).body.items as Array<{ notes: string }>;
    expect(purchases).toHaveLength(1);
    expect(purchases[0]!.notes).toBe('recorded before the update');
    const stock = (await api(page, '/api/stock/summary')).body.stages as Array<{
      stage: string;
      qty: number;
    }>;
    expect(stock.find((s) => s.stage === 'RAW')?.qty).toBe(7500);
  });

  test('refuses a damaged download instead of installing it', async ({ page }) => {
    await useFeed(page, 'corrupt');
    await bootAndSignIn(page);

    expect((await api(page, '/api/system/update-check')).body.updateAvailable).toBe(true);
    expect((await api(page, '/api/system/update', { method: 'POST' })).status).toBe(202);

    await expect
      .poll(async () => (await api(page, '/api/system/update-status')).body.state, {
        timeout: 30_000,
      })
      .toBe('failed');
    const status = await api(page, '/api/system/update-status');
    expect(String(status.body.detail)).toMatch(/damaged|checksum/i);

    // Nothing was activated.
    const state = await bundleState(page);
    expect(state.bundles?.pending ?? null).toBeNull();
    expect(state.basePath).toBeNull();
  });

  test('refuses an incomplete bundle that could not start', async ({ page }) => {
    await useFeed(page, 'broken');
    await bootAndSignIn(page);

    expect((await api(page, '/api/system/update-check')).body.updateAvailable).toBe(true);
    expect((await api(page, '/api/system/update', { method: 'POST' })).status).toBe(202);

    await expect
      .poll(async () => (await api(page, '/api/system/update-status')).body.state, {
        timeout: 30_000,
      })
      .toBe('failed');
    expect(String((await api(page, '/api/system/update-status')).body.detail)).toMatch(
      /incomplete/i,
    );
    expect((await bundleState(page)).basePath).toBeNull();
  });

  test('puts the previous version back when a new one will not start', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('form', { timeout: 45_000 });

    // Stage exactly what the device would look like after installing a bundle that has
    // already failed to boot once: it is on its last attempt.
    await page.evaluate(() => {
      localStorage.setItem('bharti.serverBasePath', '/bundles/9.9.9');
      localStorage.setItem(
        'bharti.bundles',
        JSON.stringify({
          active: { version: '1.0.1', path: '/bundles/1.0.1' },
          previous: { version: '1.0.1', path: '/bundles/1.0.1' },
          pending: {
            version: '9.9.9',
            path: '/bundles/9.9.9',
            attempts: 2,
            startedAt: new Date().toISOString(),
          },
        }),
      );
    });
    await page.reload();
    await page.waitForSelector('form', { timeout: 45_000 });

    const state = await bundleState(page);
    expect(state.bundles?.pending).toBeNull();
    expect(state.bundles?.active?.version).toBe('1.0.1');
    expect(state.basePath).toBe('/bundles/1.0.1');

    // …and the user is told, rather than silently finding an older version running.
    await expect
      .poll(async () => (await api(page, '/api/system/update-status')).body.rolledBackFrom, {
        timeout: 15_000,
      })
      .toBe('9.9.9');

    // …and once signed in, the banner says so rather than leaving the user to wonder
    // why the version they installed is not the one running.
    await bootAndSignIn(page);
    // Brand-new device: clear the first-run wizard so the main screen (and its banner) shows.
    await api(page, '/api/system/setup/complete', { method: 'POST' });
    await page.goto('/');
    const notice = page.getByText(/would not start.*previous version was restored/i);
    await expect(notice).toBeVisible({ timeout: 20_000 });

    await page.getByRole('button', { name: 'Dismiss' }).click();
    await expect(notice).toBeHidden();
    // The in-app requests never touch the network, so wait on the recorded state itself.
    await expect
      .poll(async () => (await bundleState(page)).rolledBackFrom, { timeout: 10_000 })
      .toBeNull();
    await page.reload();
    await page.waitForSelector('header', { timeout: 45_000 });
    await expect(notice).toBeHidden(); // stays dismissed
  });
});
