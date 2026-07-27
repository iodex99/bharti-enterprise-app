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

// runs after cutting/full-chain/jobs specs, so purchases and jobs exist
test('lists support facet filters, date range and sorting', async ({ page }) => {
  // On a phone a list is CARDS with a "Sort by" picker; on a laptop it is a table with
  // click-to-sort headings (ADR-038). Both are exercised here, on their own affordance.
  const phone = test.info().project.name === 'mobile';
  await signIn(page, 'owner', 'Owner@123');
  await page.goto('/purchases');
  await expect(page.getByText(/\d+ of \d+/)).toBeVisible();

  // facet filter: choose a specific color, every visible row then shows it
  const colorFacet = page.getByLabel('Filter Color');
  const firstColor = await colorFacet.locator('option').nth(1).textContent();
  await colorFacet.selectOption({ index: 1 });
  // cards carry role=row too, but the table adds a heading row that is not data
  const rows = phone ? page.getByRole('row') : page.locator('tbody tr');
  const rowCount = await rows.count();
  expect(rowCount).toBeGreaterThan(0);
  for (let i = 0; i < rowCount; i++) {
    await expect(rows.nth(i)).toContainText(firstColor!);
  }

  // clear filters restores the full list
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.getByLabel('Filter Color')).toHaveValue('');

  // date range narrows to zero for a far-future window
  await page.getByLabel('Filter Purchase date from').fill('2099-01-01');
  await expect(page.getByText('No matches for the current filters')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();

  // sorting by Length: ascending then descending must reorder the list
  const sortAsc = async () =>
    phone
      ? page.getByLabel('Sort by').selectOption({ label: 'Length ↑' })
      : page.getByRole('button', { name: /^Length/ }).click();
  const sortDesc = async () =>
    phone
      ? page.getByLabel('Sort by').selectOption({ label: 'Length ↓' })
      : page.getByRole('button', { name: /^Length/ }).click();
  await sortAsc();
  const first = await rows.first().textContent();
  await sortDesc();
  const firstDesc = await rows.first().textContent();
  expect(first).not.toBe(firstDesc);

  // jobs list has status/contractor facets too
  await page.goto('/jobs');
  await expect(page.getByText(/\d+ of \d+/)).toBeVisible();
  await expect(page.getByLabel('Filter Status')).toBeVisible();
  await expect(page.getByLabel('Filter Contractor')).toBeVisible();
});

test('Complete Business Report downloads in both formats', async ({ page }) => {
  await signIn(page, 'owner', 'Owner@123');
  await page.goto('/reports');

  const htmlDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: /Visual report \(HTML\)/ }).click();
  expect((await htmlDownload).suggestedFilename()).toMatch(/business-report-.*\.html/);

  const xlsxDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: /Excel workbook/ }).click();
  expect((await xlsxDownload).suggestedFilename()).toMatch(/business-report-.*\.xlsx/);
});
