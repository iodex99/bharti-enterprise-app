import { expect, test } from '@playwright/test';

test('app shell loads and reports server health', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Bharti Enterprises' })).toBeVisible();
  await expect(page.getByText(/Server online/)).toBeVisible();
});

test('health endpoint responds', async ({ request }) => {
  const res = await request.get('/api/system/health');
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
});
