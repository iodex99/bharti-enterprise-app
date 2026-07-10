import { expect, test, type Page } from '@playwright/test';

async function signIn(page: Page, username: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();
}

test('full cutting flow: purchase cloth, plan, record actuals with variance, see CUT stock', async ({
  page,
}) => {
  const project = test.info().project.name;
  await signIn(page, 'operator', 'Operator@123');

  // 1. a purchase to cut from
  await page.goto('/purchases');
  await page.getByRole('button', { name: '+ New purchase' }).click();
  await page.getByLabel('Vendor').selectOption({ index: 1 });
  await page.getByLabel('Model').selectOption({ index: project === 'mobile' ? 2 : 1 });
  await page.getByLabel('Color').selectOption({ label: project === 'mobile' ? 'Navy Blue' : 'Emerald' });
  await page.getByLabel('Quantity (meters)').fill('80');
  await page.getByLabel('Rate per meter').fill('50');
  await page.getByRole('button', { name: 'Save purchase' }).click();
  await expect(page.getByRole('cell', { name: /RM-\d+/ }).first()).toBeVisible();

  // 2. plan a cut from that batch
  await page.goto('/cutting');
  await page.getByRole('button', { name: '+ New cutting plan' }).click();
  const lotSelect = page.getByLabel('Cloth batch (raw material)');
  const optionLabel = project === 'mobile' ? /Navy Blue/ : /Emerald/;
  await lotSelect.selectOption({ label: (await lotSelect.locator('option', { hasText: optionLabel }).first().textContent())! });
  await page.getByLabel('Cloth to use (meters)').fill('60');
  await page.getByLabel('Size 1').selectOption({ label: 'XS' });
  await page.getByRole('textbox', { name: 'Dozens' }).fill('10');
  await page.getByRole('button', { name: 'Save cutting plan' }).click();
  await expect(page.getByRole('cell', { name: /CUT-\d+/ }).first()).toBeVisible();
  await expect(page.getByText('planned').first()).toBeVisible();

  // 3. record actuals with a shortfall — reason required, then saved
  const row = page.getByRole('row', { name: /CUT-\d+/ }).first();
  await row.getByRole('button', { name: 'Record actuals' }).click();
  await page.getByRole('textbox', { name: 'Dozens' }).fill('9'); // 9dz vs 10dz expected
  await expect(page.getByText(/-1dz/)).toBeVisible(); // live variance
  // try saving without a reason
  await page.getByRole('button', { name: 'Complete cutting' }).click();
  await expect(page.getByText(/needs a reason/i)).toBeVisible();
  await page.getByLabel('Reason for XS').selectOption({ label: 'Wastage' });
  await page.getByRole('button', { name: 'Complete cutting' }).click();

  await expect(page.getByText('completed').first()).toBeVisible();
  await expect(page.getByText('-10%').first()).toBeVisible(); // 108 vs 120

  // 4. CUT stock shows the yield
  await page.goto('/stock/cut');
  await expect(page.getByRole('cell', { name: '9dz', exact: true }).first()).toBeVisible();
});
