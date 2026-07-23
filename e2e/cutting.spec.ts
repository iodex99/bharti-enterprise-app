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

test('full cutting flow: purchase cloth, plan, record actuals with variance, see CUT stock', async ({
  page,
}) => {
  const project = test.info().project.name;
  await signIn(page, 'operator', 'Operator@123');

  // 1. a purchase to cut from — NO model at purchase (decided at cutting)
  await page.goto('/purchases');
  await page.getByRole('button', { name: '+ New purchase' }).click();
  await page.getByRole('dialog').getByLabel('Vendor').selectOption({ index: 1 });
  await page.getByRole('dialog').getByLabel('Color').selectOption({ label: project === 'mobile' ? 'Navy Blue' : 'Emerald' });
  await page.getByRole('dialog').getByLabel('Quantity (meters)').fill('80');
  await page.getByRole('dialog').getByLabel('Rate per meter').fill('50');
  await page.getByRole('button', { name: 'Save purchase' }).click();
  await expect(page.getByRole('cell', { name: /RM-\d+/ }).first()).toBeVisible();

  // 2. plan a cut from that batch: model chosen HERE; cloth computed from inches × width
  await page.goto('/cutting');
  await page.getByRole('button', { name: '+ New cutting plan' }).click();
  const lotSelect = page.getByRole('dialog').getByLabel('Cloth batch (raw material)');
  const optionLabel = project === 'mobile' ? /Navy Blue/ : /Emerald/;
  await lotSelect.selectOption({ label: (await lotSelect.locator('option', { hasText: optionLabel }).first().textContent())! });
  await page.getByRole('dialog').getByLabel('Model (decided at cutting)').selectOption({ index: project === 'mobile' ? 2 : 1 });
  await page.getByRole('dialog').getByLabel('Size 1').selectOption({ label: 'XS' });
  await page.getByRole('textbox', { name: 'Dozens' }).fill('10'); // 120 pcs
  await page.getByRole('textbox', { name: 'Cloth per piece 1' }).fill('10'); // 10" per piece
  await page.getByRole('textbox', { name: 'Across width 1' }).fill('3'); // 3 across
  // live reverse-calculation: 40 strips × 10" = 10.16 m needed, remaining shown
  await expect(page.getByText(/Cloth needed: .*10\.16 m/)).toBeVisible();
  await expect(page.getByText(/left after cutting/)).toBeVisible();
  await page.getByRole('button', { name: 'Save cutting plan' }).click();
  await expect(page.getByRole('cell', { name: /CUT-\d+/ }).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: 'planned' }).first()).toBeVisible();

  // 2b. a planned batch can be edited (doc number kept) — open, verify, close
  const plannedRow = page.getByRole('row', { name: /CUT-\d+/ }).first();
  await plannedRow.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByRole('dialog', { name: /Edit plan — CUT-/ })).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  // 3. record actuals with a shortfall — reason required, then saved
  const row = page.getByRole('row', { name: /CUT-\d+/ }).first();
  await row.getByRole('button', { name: 'Record actuals' }).click();
  await page.getByRole('textbox', { name: 'Dozens' }).fill('9'); // 9dz vs 10dz expected
  await expect(page.getByText(/-1dz/)).toBeVisible(); // live variance
  // try saving without a reason
  await page.getByRole('button', { name: 'Complete cutting' }).click();
  await expect(page.getByText(/needs a reason/i)).toBeVisible();
  await page.getByRole('dialog').getByLabel('Reason for XS').selectOption({ label: 'Wastage' });
  await page.getByRole('button', { name: 'Complete cutting' }).click();

  await expect(page.getByRole('cell', { name: 'completed' }).first()).toBeVisible();
  await expect(page.getByText('-10%').first()).toBeVisible(); // 108 vs 120

  // 4. CUT stock shows the yield
  await page.goto('/stock/cut');
  await expect(page.getByRole('cell', { name: '9dz', exact: true }).first()).toBeVisible();
});
