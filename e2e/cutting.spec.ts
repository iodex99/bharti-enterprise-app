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
 * Cutting v2: the entry IS the cutting (no separate "record actuals"), the CODE
 * NUMBER is typed per size line, pieces-across-the-width drives the cloth math,
 * and entries can be edited/deleted while nothing has been issued downstream.
 */
test('full cutting flow: purchase cloth, cut with a typed code, edit, delete', async ({ page }) => {
  const mobile = test.info().project.name === 'mobile';
  const color = mobile ? 'Navy Blue' : 'Emerald';
  const code = mobile ? 'CUT-M' : 'CUT-D';
  await signIn(page, 'operator', 'Operator@123');

  // 1. a purchase to cut from — NO code at purchase (given at cutting)
  await page.goto('/purchases');
  await page.getByRole('button', { name: '+ New purchase' }).click();
  await page.getByRole('dialog').getByLabel('Vendor').selectOption({ index: 1 });
  await page.getByRole('dialog').getByLabel('Color').selectOption({ label: color });
  await page.getByRole('dialog').getByLabel('Length (yards)').fill('80');
  await page.getByRole('dialog').getByLabel('Width (inches)').fill('44');
  await page.getByRole('dialog').getByLabel('Rate per yard').fill('50');
  await page.getByRole('button', { name: 'Save purchase' }).click();
  await expect(page.getByRole('cell', { name: /RM-\d+/ }).first()).toBeVisible();

  // 2. record the cutting: code typed HERE; cloth computed from inches × pieces-across
  await page.goto('/cutting');
  await page.getByRole('button', { name: '+ New cutting' }).click();
  const dialog = page.getByRole('dialog', { name: 'New cutting' });
  const lotSelect = dialog.getByLabel('Cloth batch');
  const lotLabel = await lotSelect.locator('option', { hasText: color }).first().textContent();
  await lotSelect.selectOption({ label: lotLabel! });
  await dialog.getByLabel('Size').selectOption({ label: 'HR' });
  await dialog.getByLabel('Code 1').fill(code);
  await dialog.getByRole('textbox', { name: 'Dozens' }).fill('10'); // 120 pcs
  await dialog.getByLabel('Cloth per piece 1').fill('10'); // 10" per piece
  await dialog.getByLabel('Pieces across width 1').fill('3'); // 3 across the 44" width
  // live calculation: ceil(120/3)=40 strips × 10" = 400" = 11.11 yd
  await expect(dialog.getByText('11.11 yd').first()).toBeVisible();
  await expect(dialog.getByText(/Left after cutting/)).toBeVisible();
  await page.getByRole('button', { name: 'Record cutting' }).click();

  // the entry is final immediately — no "record actuals" step exists any more
  await expect(page.getByRole('cell', { name: /CUT-\d+/ }).first()).toBeVisible();
  const row = page.getByRole('row', { name: new RegExp(`${code}-HR`) }).first();
  await expect(row.getByText('editable')).toBeVisible();
  await expect(row.getByRole('button', { name: 'Record actuals' })).toHaveCount(0);
  await expect(row.getByText('10dz')).toBeVisible();

  // 3. the size-code opens with its detail, and the entry can be EDITED (doc no kept)
  await row.getByRole('button', { name: 'Edit' }).click();
  const editDialog = page.getByRole('dialog', { name: /Edit cutting CUT-/ });
  await expect(editDialog).toBeVisible();
  // change 10dz -> 9dz; the batch keeps its doc number
  await editDialog.getByRole('textbox', { name: 'Dozens' }).fill('9');
  await editDialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(row.getByText('9dz')).toBeVisible();

  // 4. CUT stock shows the yield under the size-code
  await page.goto('/stock/cut');
  const stockRow = page.getByRole('row', { name: new RegExp(`${code}`) }).first();
  await expect(stockRow.getByText('9dz', { exact: true })).toBeVisible();

  // 5. an un-issued entry can be DELETED — the cloth returns to the roll
  await page.goto('/cutting');
  const delRow = page.getByRole('row', { name: new RegExp(`${code}-HR`) }).first();
  await delRow.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Delete cutting entry' }).click();
  // the entry leaves the working list (it stays in history as deleted)
  await expect(page.getByRole('row', { name: new RegExp(`${code}-HR`) })).toHaveCount(0);

  // the purchase got its cloth back (80 yd remaining again)
  await page.goto('/purchases');
  const purchaseRow = page.getByRole('row', { name: new RegExp(color) }).first();
  await expect(purchaseRow.getByText('80 yd').nth(1)).toBeVisible(); // length AND remaining
});
