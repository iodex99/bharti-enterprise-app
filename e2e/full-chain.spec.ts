import { expect, test, type Page } from '@playwright/test';

async function signIn(page: Page, username: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();
}

/**
 * THE spec's headline scenario, end to end in the browser:
 * purchase cloth → cut → issue to contractor → receive stitched → check (with rejects)
 * → pack → finished goods visible in inventory. Runs once per browser project with
 * distinct model/color fixtures (desktop: Satin+Baby Pink, mobile: Cotton+Emerald… both
 * seeded colors) so the two runs never collide.
 */
test('purchase → cutting → job work → checking → packing → finished goods', async ({ page }) => {
  const mobile = test.info().project.name === 'mobile';
  // colors no other spec buys, so the raw-lot picker always finds OUR fresh lot first
  const color = mobile ? 'Baby Pink' : 'Maroon';
  const modelIndex = mobile ? 2 : 3;
  await signIn(page, 'operator', 'Operator@123');

  // 1. purchase 60m
  await page.goto('/purchases');
  await page.getByRole('button', { name: '+ New purchase' }).click();
  await page.getByLabel('Vendor').selectOption({ index: 2 });
  await page.getByLabel('Model').selectOption({ index: modelIndex });
  await page.getByLabel('Color').selectOption({ label: color });
  await page.getByLabel('Quantity (meters)').fill('60');
  await page.getByLabel('Rate per meter').fill('42');
  await page.getByRole('button', { name: 'Save purchase' }).click();
  await expect(page.getByRole('cell', { name: /RM-\d+/ }).first()).toBeVisible();

  // 2. cut 5 dz XL
  await page.goto('/cutting');
  await page.getByRole('button', { name: '+ New cutting plan' }).click();
  const lotSelect = page.getByLabel('Cloth batch (raw material)');
  const lotLabel = await lotSelect.locator('option', { hasText: color }).first().textContent();
  await lotSelect.selectOption({ label: lotLabel! });
  await page.getByLabel('Cloth to use (meters)').fill('30');
  await page.getByLabel('Size 1').selectOption({ label: 'XL' });
  await page.getByRole('textbox', { name: 'Dozens' }).fill('5');
  await page.getByRole('button', { name: 'Save cutting plan' }).click();
  const cutRow = page.getByRole('row', { name: /CUT-\d+/ }).first();
  await cutRow.getByRole('button', { name: 'Record actuals' }).click();
  await page.getByRole('textbox', { name: 'Dozens' }).fill('5');
  await page.getByRole('button', { name: 'Complete cutting' }).click();
  await expect(page.getByText('completed').first()).toBeVisible();

  // 3. job to contractor, receive all stitched
  await page.goto('/jobs');
  await page.getByRole('button', { name: '+ New job card' }).click();
  await page.getByLabel('Contractor').selectOption({ label: 'Sunita Job Work' });
  await page.getByLabel('Model').selectOption({ index: modelIndex });
  await page.getByLabel('Color').selectOption({ label: color });
  await page.getByLabel('Size 1').selectOption({ label: 'XL' });
  await page.getByRole('textbox', { name: 'Dozens' }).fill('5');
  await page.getByRole('button', { name: 'Issue job card' }).click();
  const jobRow = page.getByRole('row', { name: /JOB-\d+/ }).first();
  await jobRow.getByRole('button', { name: 'Open' }).click();
  await page.getByRole('button', { name: 'Receive goods' }).click();
  await page.getByRole('dialog', { name: /Receive against/ }).getByRole('textbox', { name: 'Dozens' }).fill('5');
  await page.getByRole('button', { name: 'Record receipt' }).click();
  await expect(page.getByRole('dialog', { name: /JOB-\d+/ }).getByText('Completed', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close window' }).click();

  // 4. checking: 4dz pass, 6pc reject (stitching), 6pc missing
  await page.goto('/checking');
  await page.getByRole('button', { name: '+ Issue to checker' }).click();
  await page.getByLabel('Checker').selectOption({ index: 1 }); // Pooja (checker)
  await page.getByLabel('Model').selectOption({ index: modelIndex });
  await page.getByLabel('Color').selectOption({ label: color });
  await page.getByLabel('Size').selectOption({ label: 'XL' });
  await page.getByRole('textbox', { name: 'Dozens' }).fill('5');
  await page.getByRole('button', { name: 'Issue for checking' }).click();
  const chkRow = page.getByRole('row', { name: /CHK-\d+/ }).first();
  await chkRow.getByRole('button', { name: 'Record result' }).click();
  const resultDialog = page.getByRole('dialog', { name: /Checking result/ });
  // DzPc inputs in dialog order: [0]=Passed, [1]=Missing, [2]=rejection (after add)
  await resultDialog.getByRole('textbox', { name: 'Dozens' }).nth(0).fill('4');
  await resultDialog.getByRole('textbox', { name: 'Pieces' }).nth(1).fill('6');
  await resultDialog.getByRole('button', { name: '+ Add rejection reason' }).click();
  await resultDialog.getByLabel('Rejection reason 1').selectOption({ label: 'Stitching Issue' });
  await resultDialog.getByRole('textbox', { name: 'Pieces' }).nth(2).fill('6');
  await resultDialog.getByRole('button', { name: /Record result/ }).click();
  await expect(page.getByText('completed').first()).toBeVisible();

  // 5. packing: all 4dz packed by Kavita (checker+packer role)
  await page.goto('/packing');
  await page.getByRole('button', { name: '+ Issue to packer' }).click();
  await page.getByLabel('Packer').selectOption({ index: 2 }); // Kavita (both)
  await page.getByLabel('Model').selectOption({ index: modelIndex });
  await page.getByLabel('Color').selectOption({ label: color });
  await page.getByLabel('Size').selectOption({ label: 'XL' });
  await page.getByRole('textbox', { name: 'Dozens' }).fill('4');
  await page.getByRole('button', { name: 'Issue for packing' }).click();
  const pckRow = page.getByRole('row', { name: /PCK-\d+/ }).first();
  await pckRow.getByRole('button', { name: 'Record result' }).click();
  const packDialog = page.getByRole('dialog', { name: /Packing result/ });
  await packDialog.getByRole('textbox', { name: 'Dozens' }).nth(0).fill('4'); // Packed
  await packDialog.getByRole('button', { name: 'Record packing result' }).click();
  await expect(page.getByText('completed').first()).toBeVisible();

  // 6. finished goods inventory shows 4dz
  await page.goto('/stock/fg');
  const fgRow = page.getByRole('row', { name: new RegExp(color) }).first();
  await expect(fgRow.getByText('4dz', { exact: true })).toBeVisible();

  // rejected stage shows the 6pc
  await page.goto('/stock/rejected');
  await expect(page.getByRole('row', { name: new RegExp(color) }).first().getByText('6pc')).toBeVisible();
});
