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

async function openNav(page: Page) {
  const burger = page.getByRole('button', { name: 'Open menu' });
  if (await burger.isVisible()) await burger.click();
}

test('operator records a purchase (yards + width) and sees it in raw stock', async ({ page }) => {
  await signIn(page, 'operator', 'Operator@123');
  await openNav(page);
  await page.getByRole('link', { name: 'Purchases' }).click();
  await expect(page.getByRole('heading', { name: 'Raw Material Purchases' })).toBeVisible();

  await page.getByRole('button', { name: '+ New purchase' }).click();
  await page.getByRole('dialog').getByLabel('Vendor').selectOption({ label: 'Sharma Textiles' });
  await page.getByRole('dialog').getByLabel('Color').selectOption({ label: 'Maroon' });
  await page.getByRole('dialog').getByLabel('Length (yards)').fill('125.5');
  await page.getByRole('dialog').getByLabel('Width (inches)').fill('44');
  await page.getByRole('dialog').getByLabel('Rate per yard').fill('45.50');
  await expect(page.locator('form').getByText('₹5,710.25')).toBeVisible(); // auto total preview
  await page.getByRole('button', { name: 'Save purchase' }).click();

  // row lands in the table with batch number, yards and the cloth width
  await expect(page.getByRole('cell', { name: /RM-\d+/ }).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: '125.5 yd' }).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: '44"' }).first()).toBeVisible();

  // raw stock shows the lot with the vendor
  await openNav(page);
  await page.getByRole('link', { name: 'Inventory' }).click();
  await expect(page.getByRole('cell', { name: 'Sharma Textiles' }).first()).toBeVisible();
});

test('purchase validation: received date before purchase date is rejected', async ({ page }) => {
  await signIn(page, 'operator', 'Operator@123');
  await page.goto('/purchases');
  await page.getByRole('button', { name: '+ New purchase' }).click();
  await page.getByRole('dialog').getByLabel('Purchase date').fill('2026-07-05');
  await page.getByRole('dialog').getByLabel('Date received').fill('2026-07-01');
  await page.getByRole('dialog').getByLabel('Vendor').selectOption({ index: 1 });
  await page.getByRole('dialog').getByLabel('Color').selectOption({ index: 1 });
  await page.getByRole('dialog').getByLabel('Length (yards)').fill('10');
  await page.getByRole('dialog').getByLabel('Width (inches)').fill('44');
  await page.getByRole('dialog').getByLabel('Rate per yard').fill('40');
  await page.getByRole('button', { name: 'Save purchase' }).click();
  await expect(page.getByText(/received date cannot be before/i)).toBeVisible();
});

test('owner sees purchases but has no entry or void controls', async ({ page }) => {
  await signIn(page, 'owner', 'Owner@123');
  await page.goto('/purchases');
  await expect(page.getByRole('heading', { name: 'Raw Material Purchases' })).toBeVisible();
  await expect(page.getByRole('button', { name: '+ New purchase' })).toHaveCount(0);
  // exact: the "Voided" status chip is a button too, and must stay
  await expect(page.getByRole('button', { name: 'Void', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
});
