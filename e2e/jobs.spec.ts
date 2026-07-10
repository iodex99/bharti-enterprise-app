import { expect, test, type Page } from '@playwright/test';

async function signIn(page: Page, username: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();
}

/**
 * Full job-work flow through the UI. Uses its own purchase+cutting fixture per
 * project (desktop/mobile share the DB) via distinct model selections.
 */
test('issue job, partial receipts, auto-complete, contractor analytics update', async ({ page }) => {
  const mobile = test.info().project.name === 'mobile';
  await signIn(page, 'operator', 'Operator@123');

  // fixture: purchase + cutting so CUT stock exists
  await page.goto('/purchases');
  await page.getByRole('button', { name: '+ New purchase' }).click();
  await page.getByLabel('Vendor').selectOption({ index: 1 });
  await page.getByLabel('Model').selectOption({ index: mobile ? 3 : 1 });
  await page.getByLabel('Color').selectOption({ label: mobile ? 'White' : 'Black' });
  await page.getByLabel('Quantity (meters)').fill('100');
  await page.getByLabel('Rate per meter').fill('40');
  await page.getByRole('button', { name: 'Save purchase' }).click();
  await expect(page.getByRole('cell', { name: /RM-\d+/ }).first()).toBeVisible();

  await page.goto('/cutting');
  await page.getByRole('button', { name: '+ New cutting plan' }).click();
  const lotSelect = page.getByLabel('Cloth batch (raw material)');
  const lotLabel = await lotSelect
    .locator('option', { hasText: mobile ? 'White' : 'Black' })
    .first()
    .textContent();
  await lotSelect.selectOption({ label: lotLabel! });
  await page.getByLabel('Cloth to use (meters)').fill('50');
  await page.getByLabel('Size 1').selectOption({ label: 'S2' });
  await page.getByRole('textbox', { name: 'Dozens' }).fill('10');
  await page.getByRole('button', { name: 'Save cutting plan' }).click();
  const cutRow = page.getByRole('row', { name: /CUT-\d+/ }).first();
  await cutRow.getByRole('button', { name: 'Record actuals' }).click();
  await page.getByRole('textbox', { name: 'Dozens' }).fill('10');
  await page.getByRole('button', { name: 'Complete cutting' }).click();
  await expect(page.getByText('completed').first()).toBeVisible();

  // issue 10dz to a contractor
  await page.goto('/jobs');
  await page.getByRole('button', { name: '+ New job card' }).click();
  await page.getByLabel('Contractor').selectOption({ label: 'Rafiq Tailors' });
  await page.getByLabel('Model').selectOption({ index: mobile ? 3 : 1 });
  await page.getByLabel('Color').selectOption({ label: mobile ? 'White' : 'Black' });
  await page.getByLabel('Size 1').selectOption({ label: 'S2' });
  await page.getByRole('textbox', { name: 'Dozens' }).fill('10');
  await expect(page.getByText(/Default rate ₹28.00/)).toBeVisible(); // auto-fetched rate
  await page.getByRole('button', { name: 'Issue job card' }).click();
  await expect(page.getByRole('cell', { name: /JOB-\d+/ }).first()).toBeVisible();

  // receipt 1: 4 dz -> partially received
  const jobRow = page.getByRole('row', { name: /JOB-\d+/ }).first();
  await jobRow.getByRole('button', { name: 'Open' }).click();
  const detail = page.getByRole('dialog', { name: /JOB-\d+/ });
  await page.getByRole('button', { name: 'Receive goods' }).click();
  await page.getByRole('dialog', { name: /Receive against/ }).getByRole('textbox', { name: 'Dozens' }).fill('4');
  await page.getByRole('button', { name: 'Record receipt' }).click();
  await expect(detail.getByText('Partially Received')).toBeVisible();

  // receipt 2: 6 dz -> completed automatically
  await page.getByRole('button', { name: 'Receive goods' }).click();
  await page.getByRole('dialog', { name: /Receive against/ }).getByRole('textbox', { name: 'Dozens' }).fill('6');
  await page.getByRole('button', { name: 'Record receipt' }).click();
  await expect(detail.getByText('Completed', { exact: true })).toBeVisible();
  await expect(detail.getByText('settled').first()).toBeVisible();
  await page.getByRole('button', { name: 'Close window' }).click();

  // contractor analytics show the delivery (desktop run: 10dz; mobile runs after desktop: 20dz)
  await page.goto('/contractors');
  const rafiqRow = page.getByRole('row', { name: /Rafiq Tailors/ });
  await expect(rafiqRow.getByText(/(10|20)dz/).first()).toBeVisible();
});

test('owner sees jobs and contractor dues read-only', async ({ page }) => {
  await signIn(page, 'owner', 'Owner@123');
  await page.goto('/jobs');
  await expect(page.getByRole('heading', { name: 'Job Work' })).toBeVisible();
  await expect(page.getByRole('button', { name: '+ New job card' })).toHaveCount(0);
  await page.goto('/contractors');
  await expect(page.getByRole('heading', { name: 'Contractors' })).toBeVisible();
  await expect(page.getByRole('button', { name: '+ Record payment' })).toHaveCount(0);
});
