import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
 * Complete backup + restore UI wiring, end to end in the browser: download the whole
 * business as one file via the real button, then feed it back into the Restore card and
 * confirm the preview shows what's inside. We stop at the confirmation (Cancel) rather than
 * committing — the actual atomic swap + rollback is covered in depth by the integration
 * suite, and a real restore on the shared E2E server would clear sessions and swap the DB.
 */
test('complete backup downloads and previews for restore', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'single-run migration flow');
  await signIn(page, 'admin', 'Admin@123');
  await page.goto('/admin/backups');

  await expect(page.getByRole('heading', { name: /Complete backup/ })).toBeVisible();

  // download via the real button — the browser sends its authenticated session cookie
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: /Download complete backup/ }).click();
  const download = await downloadPromise;
  const file = path.join(os.tmpdir(), `bharti-e2e-backup-${testInfo.workerIndex}.zip`);
  await download.saveAs(file);
  expect(fs.statSync(file).size).toBeGreaterThan(0);

  // feed it back into the Restore card; the preview must report what's inside the backup
  await page.locator('input[type="file"]').setInputFiles(file);
  await expect(page.getByText('You are about to replace ALL current data with:')).toBeVisible();
  await expect(page.getByText(/purchases/)).toBeVisible();

  // the commit button is gated until "RESTORE" is typed
  const commitBtn = page.getByRole('button', { name: 'Replace all data now' });
  await expect(commitBtn).toBeDisabled();
  await page.getByLabel('Type RESTORE to confirm').fill('RESTORE');
  await expect(commitBtn).toBeEnabled();

  // stop here — don't wipe the shared server; the real swap is integration-tested
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('You are about to replace ALL current data with:')).toBeHidden();

  fs.rmSync(file, { force: true });
});
