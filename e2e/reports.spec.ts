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

test('owner runs a report and downloads the Excel file', async ({ page }) => {
  await signIn(page, 'owner', 'Owner@123');
  await page.goto('/reports');
  await page.getByLabel('Report').selectOption({ label: 'Raw Material Stock' });
  // data exists from earlier specs (desktop) or shows empty state (fine either way);
  // the xlsx download must work regardless
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /Download Excel/ }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/raw-stock-.*\.xlsx/);
});

test('owner traces a finished-goods batch back to the vendor', async ({ page }) => {
  await signIn(page, 'owner', 'Owner@123');
  await page.goto('/trace');
  const picker = page.getByLabel('Finished goods batch');
  // full-chain.spec has produced FG lots by the time this runs (alphabetical order)
  const options = picker.locator('option');
  await expect(options.nth(1)).toBeAttached();
  await picker.selectOption({ index: 1 });
  // the tree shows the whole chain
  await expect(page.getByText(/Finished Goods/).first()).toBeVisible();
  await expect(page.getByText(/Stitched by/).first()).toBeVisible();
  await expect(page.getByText(/Cloth from/).first()).toBeVisible();
});
