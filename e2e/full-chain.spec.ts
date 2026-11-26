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
 * THE spec's headline scenario, end to end in the browser (v2):
 * purchase cloth (yards+width) → cut with a typed code → issue to contractor →
 * receive stitched WITH PHOTO → check (rejects incl. "missing" as a reason) →
 * pack straight from the checking row (checker packs by default) + keep a bundle
 * aside → pack the bundle later → finished goods → discrepancy review.
 * Distinct color+code per project so the two runs never collide.
 */
test('purchase → cutting → job work → checking → packing (+bundle) → finished goods', async ({
  page,
}) => {
  const mobile = test.info().project.name === 'mobile';
  // colors no other spec buys, so the raw-lot picker always finds OUR fresh lot first
  const color = mobile ? 'Baby Pink' : 'Maroon';
  const code = mobile ? 'FC-M' : 'FC-D';
  await signIn(page, 'operator', 'Operator@123');

  // 1. purchase 60 yd of 44"-wide cloth — no code at purchase
  await page.goto('/purchases');
  await page.getByRole('button', { name: '+ New purchase' }).click();
  await page.getByRole('dialog').getByLabel('Vendor').selectOption({ index: 2 });
  await page.getByRole('dialog').getByLabel('Color').selectOption({ label: color });
  await page.getByRole('dialog').getByLabel('Length (yards)').fill('60');
  await page.getByRole('dialog').getByLabel('Width (inches)').fill('44');
  await page.getByRole('dialog').getByLabel('Rate per yard').fill('42');
  await page.getByRole('button', { name: 'Save purchase' }).click();
  await expect(page.getByRole('cell', { name: /RM-\d+/ }).first()).toBeVisible();

  // 2. cut 5 dz XL — code typed here; cloth = ceil(60/2) strips × 14"
  await page.goto('/cutting');
  await page.getByRole('button', { name: '+ New cutting' }).click();
  const cutDialog = page.getByRole('dialog', { name: 'New cutting' });
  const lotSelect = cutDialog.getByLabel('Cloth batch');
  const lotLabel = await lotSelect.locator('option', { hasText: color }).first().textContent();
  await lotSelect.selectOption({ label: lotLabel! });
  await cutDialog.getByLabel('Size').selectOption({ label: 'JUMBO' });
  await cutDialog.getByLabel('Code 1').fill(code);
  await cutDialog.getByRole('textbox', { name: 'Dozens' }).fill('5');
  await cutDialog.getByLabel('Cloth per piece 1').fill('14');
  await cutDialog.getByLabel('Pieces across width 1').fill('2');
  await expect(cutDialog.getByText(/Left after cutting/)).toBeVisible();
  await page.getByRole('button', { name: 'Record cutting' }).click();
  await expect(page.getByRole('cell', { name: /CUT-\d+/ }).first()).toBeVisible();

  // 3. job to contractor, receive all stitched (photo required)
  await page.goto('/jobs');
  await expect(page.getByText(/\d+ of \d+/)).toBeVisible();
  const jobRowsBefore = await page.getByRole('row', { name: /JOB-\d+/ }).count();
  await page.getByRole('button', { name: '+ Issue goods' }).click();
  const jobDialog = page.getByRole('dialog', { name: 'Issue goods to a contractor' });
  await jobDialog.getByLabel('Contractor').selectOption({ label: 'Sunita Job Work' });
  await jobDialog.getByLabel('Code 1').selectOption({ label: code });
  await jobDialog.getByLabel('Color 1').selectOption({ label: color });
  await jobDialog.getByLabel('Size 1').selectOption({ label: 'JUMBO' });
  await jobDialog.getByRole('textbox', { name: 'Dozens' }).fill('5');
  await jobDialog.getByRole('button', { name: 'Issue goods' }).click();
  await expect(page.getByText(/Job card JOB-\d+ created/)).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('row', { name: /JOB-\d+/ })).toHaveCount(jobRowsBefore + 1);
  const jobRow = page.getByRole('row', { name: new RegExp(code) }).first();
  await jobRow.getByRole('button', { name: 'Open' }).click();
  await page.getByRole('button', { name: 'Receive goods' }).click();
  const receiveDialog = page.getByRole('dialog', { name: /Receive against/ });
  await receiveDialog.getByRole('textbox', { name: 'Dozens' }).fill('5');
  await receiveDialog.locator('input[type=file]').setInputFiles({
    name: 'returned.png',
    mimeType: 'image/png',
    buffer: TINY_PNG,
  });
  await expect(receiveDialog.getByAltText('Reference')).toBeVisible(); // upload finished
  await receiveDialog.getByRole('button', { name: 'Record receipt' }).click();
  await expect(
    page.getByRole('dialog', { name: /JOB-\d+/ }).getByText('Completed', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close window' }).click();

  // 4. checking: the received batch sits in "Pending for checking" with the contractor's
  // name and the return photo — allot THAT batch to a checker
  await page.goto('/checking');
  const pendingRow = page
    .getByRole('row', { name: new RegExp(code) })
    .filter({ hasText: 'Sunita Job Work' })
    .first();
  await expect(pendingRow).toBeVisible();
  await pendingRow.getByRole('button', { name: 'Issue to checker' }).click();
  await page.getByRole('dialog').getByLabel('Checker').selectOption({ label: 'Pooja' });
  // quantity defaults to the whole batch (5 dz) — issue it all
  await page.getByRole('button', { name: 'Issue for checking' }).click();

  // 5. result: 4dz pass; 6pc rejected for stitching; 6pc "missing" — a reason in the
  // SAME rejected dropdown (there is no separate missing box any more)
  const chkRow = page.getByRole('row', { name: /CHK-\d+/ }).first();
  await chkRow.getByRole('button', { name: 'Record result' }).click();
  const resultDialog = page.getByRole('dialog', { name: /Checking result/ });
  await resultDialog.getByRole('textbox', { name: 'Dozens' }).nth(0).fill('4'); // Passed
  await resultDialog.getByRole('button', { name: /Add rejected pieces/ }).click();
  await resultDialog.getByLabel('Rejection reason 1').selectOption({ label: 'Stitching Issue' });
  await resultDialog.getByRole('textbox', { name: 'Pieces' }).nth(1).fill('6');
  await resultDialog.getByRole('button', { name: /Add rejected pieces/ }).click();
  await resultDialog.getByLabel('Rejection reason 2').selectOption({ label: 'Missing' });
  await resultDialog.getByRole('textbox', { name: 'Pieces' }).nth(2).fill('6');
  await resultDialog.getByRole('button', { name: /^Record result \(/ }).click();

  // the checked row now offers its passed pieces for packing
  const checkedRow = page.getByRole('row', { name: /CHK-\d+/ }).first();
  await expect(checkedRow.getByText('4dz to pack')).toBeVisible();

  // 6a. pack 3dz now — the checker (Pooja) is the default packer
  await checkedRow.getByRole('button', { name: 'Pack', exact: true }).click();
  const packDialog = page.getByRole('dialog', { name: /^Pack — / });
  await expect(packDialog.getByText(/checker packs their own goods/)).toBeVisible();
  await expect(packDialog.getByLabel('Packer')).toHaveValue(/\d+/); // pre-selected
  await packDialog.getByRole('textbox', { name: 'Dozens' }).fill('3');
  await packDialog.getByRole('button', { name: 'Allot for packing' }).click();

  // 6b. keep the last 1dz aside as a labeled BUNDLE for later
  await expect(checkedRow.getByText('1dz to pack')).toBeVisible();
  await checkedRow.getByRole('button', { name: 'Pack', exact: true }).click();
  const bundleDialog = page.getByRole('dialog', { name: /^Pack — / });
  await bundleDialog
    .getByLabel('What happens to these pieces?')
    .selectOption({ label: 'Keep aside as a bundle (pack later)' });
  await bundleDialog.getByLabel('Bundle name').fill(`Reserve ${code}`);
  await bundleDialog.getByRole('button', { name: 'Keep bundle aside' }).click();

  // 7. record the 3dz packing from "Packing in progress"
  const packWorkRow = page
    .getByRole('row', { name: /PCK-\d+/ })
    .filter({ hasText: new RegExp(code) })
    .first();
  await packWorkRow.getByRole('button', { name: 'Record packing' }).click();
  const packResult = page.getByRole('dialog', { name: /Packing result/ });
  await packResult.getByRole('textbox', { name: 'Dozens' }).nth(0).fill('3'); // Packed
  await packResult.getByRole('button', { name: 'Record packing' }).click();

  // 8. the bundle sits in "Bundles kept aside" — pack it whenever needed
  const bundleRow = page.getByRole('row', { name: new RegExp(`Reserve ${code}`) }).first();
  await expect(bundleRow).toBeVisible();
  await bundleRow.getByRole('button', { name: 'Pack from bundle' }).click();
  const bundleResult = page.getByRole('dialog', { name: /Pack from bundle/ });
  await bundleResult.getByRole('textbox', { name: 'Dozens' }).nth(0).fill('1');
  await bundleResult.getByRole('button', { name: 'Record packing' }).click();
  await expect(bundleRow).toHaveCount(0); // fully packed — the bundle is gone

  // 9. finished goods inventory shows all 4dz under the size-code
  await page.goto('/stock/fg');
  const fgRow = page.getByRole('row', { name: new RegExp(code) }).first();
  await expect(fgRow.getByText('4dz', { exact: true })).toBeVisible();

  // rejected stage shows the 6pc (missing pieces are NOT stock — they are written off)
  await page.goto('/stock/rejected');
  await expect(
    page
      .getByRole('row', { name: new RegExp(code) })
      .first()
      .getByText('6pc'),
  ).toBeVisible();

  // 10. the "missing" pieces landed on the Discrepancies review page
  await page.goto('/discrepancies');
  const missingRow = page
    .getByRole('row', { name: new RegExp(code) })
    .filter({ hasText: 'Missing' })
    .first();
  await expect(missingRow).toBeVisible();
  await expect(missingRow.getByText('unresolved', { exact: true })).toBeVisible();
  // operator can review but not resolve
  await expect(missingRow.getByRole('button', { name: 'Resolve' })).toHaveCount(0);

  // admin resolves it with a note; the badge flips
  await page.request.post('/api/auth/logout');
  await signIn(page, 'admin', 'Admin@123');
  await page.goto('/discrepancies');
  await missingRow.getByRole('button', { name: 'Resolve' }).click();
  await page
    .getByRole('dialog', { name: 'Resolve discrepancy' })
    .getByLabel('Resolution note')
    .fill('checker recount — settled against contractor dues');
  await page.getByRole('button', { name: 'Mark resolved' }).click();
  await expect(missingRow.getByText('resolved', { exact: true })).toBeVisible();
});
