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

/** A 1×1 PNG for the required returned-goods photo. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Full job-work flow through the UI. Uses its own purchase+cutting fixture per
 * project (desktop/mobile share the DB) via distinct codes and colors.
 */
test('issue goods, partial receipts with photo, auto-complete, contractor analytics', async ({
  page,
}) => {
  const mobile = test.info().project.name === 'mobile';
  const color = mobile ? 'White' : 'Black';
  const code = mobile ? 'JOB-M' : 'JOB-D';
  await signIn(page, 'operator', 'Operator@123');

  // fixture: purchase + cutting so CUT stock exists under our code
  await page.goto('/purchases');
  await page.getByRole('button', { name: '+ New purchase' }).click();
  await page.getByRole('dialog').getByLabel('Vendor').selectOption({ index: 1 });
  await page.getByRole('dialog').getByLabel('Color').selectOption({ label: color });
  await page.getByRole('dialog').getByLabel('Length (yards)').fill('100');
  await page.getByRole('dialog').getByLabel('Width (inches)').fill('44');
  await page.getByRole('dialog').getByLabel('Rate per yard').fill('40');
  await page.getByRole('button', { name: 'Save purchase' }).click();
  await expect(page.getByRole('cell', { name: /RM-\d+/ }).first()).toBeVisible();

  await page.goto('/cutting');
  await page.getByRole('button', { name: '+ New cutting' }).click();
  const cutDialog = page.getByRole('dialog', { name: 'New cutting' });
  const lotSelect = cutDialog.getByLabel('Cloth batch');
  const lotLabel = await lotSelect.locator('option', { hasText: color }).first().textContent();
  await lotSelect.selectOption({ label: lotLabel! });
  await cutDialog.getByLabel('Size').selectOption({ label: 'PIPE' });
  await cutDialog.getByLabel('Code 1').fill(code);
  await cutDialog.getByRole('textbox', { name: 'Dozens' }).fill('10');
  await cutDialog.getByLabel('Cloth per piece 1').fill('10');
  await cutDialog.getByLabel('Pieces across width 1').fill('3');
  await page.getByRole('button', { name: 'Record cutting' }).click();
  await expect(page.getByRole('cell', { name: /CUT-\d+/ }).first()).toBeVisible();

  // issue 10dz to a contractor — per-dozen cost auto-fetched from the contractor
  await page.goto('/jobs');
  // the DataTable renders "N of M" once loaded — count() alone doesn't wait
  await expect(page.getByText(/\d+ of \d+/)).toBeVisible();
  const jobRowsBefore = await page.getByRole('row', { name: /JOB-\d+/ }).count();
  await page.getByRole('button', { name: '+ Issue goods' }).click();
  const jobDialog = page.getByRole('dialog', { name: 'Issue goods to a contractor' });
  await jobDialog.getByLabel('Contractor').selectOption({ label: 'Rafiq Tailors' });
  await expect(jobDialog.getByText(/Default cost ₹28.00\/dz/)).toBeVisible(); // cost set at issue
  await jobDialog.getByLabel('Code 1').selectOption({ label: code });
  await jobDialog.getByLabel('Color 1').selectOption({ label: color });
  await jobDialog.getByLabel('Size 1').selectOption({ label: 'PIPE' });
  await jobDialog.getByRole('textbox', { name: 'Dozens' }).fill('10');
  await jobDialog.getByRole('button', { name: 'Issue goods' }).click();
  // creation is confirmed with the new card's number
  await expect(page.getByText(/Job card JOB-\d+ created/)).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();

  // wait for the NEW row before clicking — every row has an "Open" button
  await expect(page.getByRole('row', { name: /JOB-\d+/ })).toHaveCount(jobRowsBefore + 1);
  const jobRow = page.getByRole('row', { name: new RegExp(code) }).first();
  await jobRow.getByRole('button', { name: 'Open' }).click();
  const detail = page.getByRole('dialog', { name: /JOB-\d+/ });

  // receipt 1: 4 dz — the returned-goods photo is REQUIRED
  await page.getByRole('button', { name: 'Receive goods' }).click();
  const receive1 = page.getByRole('dialog', { name: /Receive against/ });
  await receive1.getByRole('textbox', { name: 'Dozens' }).fill('4');
  await receive1.getByRole('button', { name: 'Record receipt' }).click();
  await expect(receive1.getByText(/Take a photo of the returned goods/)).toBeVisible();
  await receive1.locator('input[type=file]').setInputFiles({
    name: 'returned.png',
    mimeType: 'image/png',
    buffer: TINY_PNG,
  });
  await expect(receive1.getByAltText('Reference')).toBeVisible(); // upload finished
  await receive1.getByRole('button', { name: 'Record receipt' }).click();
  await expect(detail.getByText('Partially Received')).toBeVisible();

  // receipt 2: 6 dz -> completed automatically
  await page.getByRole('button', { name: 'Receive goods' }).click();
  const receive2 = page.getByRole('dialog', { name: /Receive against/ });
  await receive2.getByRole('textbox', { name: 'Dozens' }).fill('6');
  await receive2.locator('input[type=file]').setInputFiles({
    name: 'returned2.png',
    mimeType: 'image/png',
    buffer: TINY_PNG,
  });
  await expect(receive2.getByAltText('Reference')).toBeVisible();
  await receive2.getByRole('button', { name: 'Record receipt' }).click();
  await expect(detail.getByText('Completed', { exact: true })).toBeVisible();
  await expect(detail.getByText('settled').first()).toBeVisible();
  await page.getByRole('button', { name: 'Close window' }).click();

  // contractor analytics show the delivery (desktop run: 10dz; mobile runs after desktop: 20dz)
  await page.goto('/contractors');
  const rafiqRow = page.getByRole('row', { name: /Rafiq Tailors/ });
  await expect(rafiqRow.getByText(/(10|20)dz/).first()).toBeVisible();

  // the job-work cost lands on Pending Dues, and a PART payment is recorded right there
  await page.goto('/dues');
  const dueRow = page.getByRole('row', { name: /Rafiq Tailors/ }).first();
  await expect(dueRow).toBeVisible();
  await dueRow.getByRole('button', { name: 'Record payment' }).click();
  const payDialog = page.getByRole('dialog', { name: /Record payment — Rafiq Tailors/ });
  await expect(payDialog.getByText(/Pending dues:/)).toBeVisible();
  await payDialog.getByLabel('Payment date').fill('2026-07-20');
  await payDialog.getByLabel('Amount').fill('50'); // part payment — the rest stays due
  await expect(payDialog.getByText(/after this payment: .* still due/)).toBeVisible();
  await payDialog.getByRole('button', { name: 'Record payment' }).click();
  // paid so far shows on the row; the balance stays pending
  await expect(dueRow.getByText(/₹(50|100)\.00/).first()).toBeVisible();
});

test('owner sees jobs and contractor dues read-only', async ({ page }) => {
  await signIn(page, 'owner', 'Owner@123');
  await page.goto('/jobs');
  await expect(page.getByRole('heading', { name: 'Job Work' })).toBeVisible();
  await expect(page.getByRole('button', { name: '+ Issue goods' })).toHaveCount(0);
  await page.goto('/contractors');
  await expect(page.getByRole('heading', { name: 'Contractors' })).toBeVisible();
  await expect(page.getByRole('button', { name: '+ Record payment' })).toHaveCount(0);

  // the dedicated pending-dues view is visible to the owner
  await page.goto('/dues');
  await expect(page.getByRole('heading', { name: 'Pending Dues' })).toBeVisible();
});
