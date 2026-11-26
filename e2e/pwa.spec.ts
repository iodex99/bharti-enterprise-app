import { expect, test, type Page } from '@playwright/test';

async function signIn(page: Page, username: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible({
    // the home screen loads its dashboard before the heading paints; 5s is not
    // enough on a loaded CI runner
    timeout: 20_000,
  });
}

test('PWA manifest and service worker install; /api is never served from cache', async ({
  page,
}) => {
  await signIn(page, 'admin', 'Admin@123');

  // manifest is linked and resolvable
  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(manifestHref).toBe('/manifest.webmanifest');
  const manifest = await page.request.get('/manifest.webmanifest');
  expect(manifest.status()).toBe(200);
  expect((await manifest.json()).display).toBe('standalone');

  // service worker takes control
  await page.waitForFunction(() => navigator.serviceWorker?.ready.then(() => true), null, {
    timeout: 10_000,
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible({
    // the home screen loads its dashboard before the heading paints; 5s is not
    // enough on a loaded CI runner
    timeout: 20_000,
  });
  const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
  expect(controlled).toBe(true);

  // /api stays live THROUGH the service worker: uptime must move between calls
  const uptime1 = await page.evaluate(
    async () => (await (await fetch('/api/system/health')).json()).uptimeSeconds,
  );
  await page.waitForTimeout(1500);
  const uptime2 = await page.evaluate(
    async () => (await (await fetch('/api/system/health')).json()).uptimeSeconds,
  );
  expect(uptime2).toBeGreaterThan(uptime1 as number);
});

test('admin System Health page shows green reconciliation and saves the delay threshold', async ({
  page,
}) => {
  await signIn(page, 'admin', 'Admin@123');
  await page.goto('/admin/system');
  await expect(page.getByRole('heading', { name: 'System Health' })).toBeVisible();
  await expect(page.getByText('all good')).toBeVisible();
  await expect(page.getByText('No negative stock lots')).toBeVisible();

  const days = page.getByLabel('Job considered delayed after (days)');
  await days.fill('9');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.reload();
  await expect(page.getByLabel('Job considered delayed after (days)')).toHaveValue('9');
});
