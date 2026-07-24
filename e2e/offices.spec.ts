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

/**
 * Multi-office (ADR-028): the admin configures offices in the app; each office's
 * documents/stock/numbering stay separate; admin+owner switch offices from the top
 * bar; operators are pinned to one office. Desktop-only: the second office persists
 * in the shared DB, so one run is enough (the mobile run would just see it exists).
 */
test('admin creates a second office, switches into it, and its data is separate', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'single-run office setup');
  await signIn(page, 'admin', 'Admin@123');

  // create the branch office (idempotent across reruns: skip if it already exists)
  await page.goto('/admin/offices');
  await expect(page.getByRole('heading', { name: 'Offices' })).toBeVisible();
  await expect(page.getByText('(first office — plain numbering)')).toBeVisible();
  const already = await page.getByRole('cell', { name: 'E2E Branch' }).count();
  if (already === 0) {
    await page.getByRole('button', { name: '+ New office' }).click();
    await page.getByLabel('Short code').fill('EB');
    await page.getByLabel('Office name').fill('E2E Branch');
    await page.getByRole('button', { name: 'Create office' }).click();
    await expect(page.getByRole('cell', { name: 'E2E Branch' })).toBeVisible();
  }
  // the numbering preview shows the office prefix
  await expect(page.getByText('EB-RM-0001, EB-JOB-0001, …')).toBeVisible();

  // switch into the branch from the top bar — the whole app reloads office-scoped
  await page.getByLabel('Office').selectOption({ label: '🏢 E2E Branch' });
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByLabel('Office')).toHaveValue(/\d+/);

  // the branch has NO purchases of its own, whatever the main office recorded
  await page.goto('/purchases');
  await expect(
    page.getByText('No purchases recorded yet').or(page.getByText('0 of 0')).first(),
  ).toBeVisible();

  // record one here: it gets the EB- prefixed document number
  await page.getByRole('button', { name: '+ New purchase' }).click();
  await page.getByRole('dialog').getByLabel('Vendor').selectOption({ index: 1 });
  await page.getByRole('dialog').getByLabel('Color').selectOption({ index: 1 });
  await page.getByRole('dialog').getByLabel('Length (yards)').fill('12');
  await page.getByRole('dialog').getByLabel('Width (inches)').fill('44');
  await page.getByRole('dialog').getByLabel('Rate per yard').fill('40');
  await page.getByRole('button', { name: 'Save purchase' }).click();
  await expect(page.getByRole('cell', { name: /EB-RM-\d+/ }).first()).toBeVisible();

  // switch back to the main office: the EB- document is not in ITS list
  await page.getByLabel('Office').selectOption({ index: 0 });
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible({ timeout: 20_000 });
  await page.goto('/purchases');
  await expect(page.getByText(/\d+ of \d+|No purchases recorded yet/).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: /EB-RM-\d+/ })).toHaveCount(0);
});

test('operator is pinned to one office and sees no office picker', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'single-run office setup');
  await signIn(page, 'operator', 'Operator@123');
  await expect(page.getByLabel('Office')).toHaveCount(0);
});
