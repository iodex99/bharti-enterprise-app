import { expect, test, type Page } from '@playwright/test';

async function signInAdmin(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill('Admin@123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();
}

async function openNav(page: Page) {
  const burger = page.getByRole('button', { name: 'Open menu' });
  if (await burger.isVisible()) await burger.click();
}

test('admin creates, edits, deactivates a color', async ({ page }) => {
  const name = `E2E-${test.info().project.name}`;
  await signInAdmin(page);
  await openNav(page);
  await page.getByRole('link', { name: 'Colors' }).click();
  await expect(page.getByRole('heading', { name: 'Colors' })).toBeVisible();

  // seeded colors are visible
  await expect(page.getByText('Maroon')).toBeVisible();

  // create
  await page.getByRole('button', { name: '+ New color' }).click();
  await page.getByLabel('Color name').fill(name);
  await page.getByLabel(/Color code/).fill('#123456');
  await page.getByRole('button', { name: 'Create color' }).click();
  await expect(page.getByRole('cell', { name })).toBeVisible();

  // validation error shows for a bad code
  await page.getByRole('button', { name: '+ New color' }).click();
  await page.getByLabel('Color name').fill(`${name}-bad`);
  await page.getByLabel(/Color code/).fill('notacolor');
  await page.getByRole('button', { name: 'Create color' }).click();
  await expect(page.getByText(/RRGGBB/)).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();

  // search narrows
  await page.getByLabel('Search').fill(name);
  await expect(page.getByRole('cell', { name: 'Maroon' })).toHaveCount(0);

  // deactivate hides the row (until "show inactive") — exact:true so the
  // “No matches for …” placeholder cell can't substring-match
  const row = page.getByRole('row', { name: new RegExp(name) });
  await row.getByRole('button', { name: 'Deactivate' }).click();
  await expect(page.getByRole('cell', { name, exact: true })).toHaveCount(0);
  await page.getByText('Show inactive').click();
  await expect(page.getByRole('cell', { name, exact: true })).toBeVisible();
});

test('operator sees masters read-only', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Username').fill('operator');
  await page.getByLabel('Password').fill('Operator@123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();

  await openNav(page);
  await page.getByRole('link', { name: 'Contractors' }).click();
  await expect(page.getByRole('heading', { name: 'Contractors' })).toBeVisible();
  await expect(page.getByText('Meena Stitching Works')).toBeVisible();
  // no mutation controls for non-admin
  await expect(page.getByRole('button', { name: /New contractor/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Deactivate' })).toHaveCount(0);
});
