import { expect, test, type Page } from '@playwright/test';

/**
 * In-app demo mode buttons. Named z- so it runs LAST in each project: it switches
 * the live server's database and restores real mode before finishing.
 */
async function signIn(page: Page, username: string, password: string) {
  // Switching demo mode ends the session, and the app sends itself to /login. That
  // redirect can land while this navigation is still in flight, which Playwright reports
  // as an interrupted navigation. Both end up on the same page, so retry and then wait
  // for the form rather than for one particular navigation to win the race.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await page.goto('/login');
      break;
    } catch (err) {
      const interrupted = String(err).includes('interrupted by another navigation');
      if (!interrupted || attempt >= 2) throw err;
    }
  }
  await page.getByLabel('Username').waitFor({ state: 'visible', timeout: 15_000 });
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible({
    // the home screen loads its dashboard before the heading paints; 5s is not
    // enough on a loaded CI runner
    timeout: 20_000,
  });
}

test('admin enters demo mode from the UI, sees demo data + banner, exits back to real data', async ({
  page,
}) => {
  page.on('dialog', (dialog) => dialog.accept());
  await signIn(page, 'admin', 'Admin@123');

  // enter demo (first run creates it; later runs reuse it)
  await page.goto('/admin/system');
  await page
    .getByRole('button', { name: /Create & enter demo mode|Enter demo mode/ })
    .click();

  // switching signs us out → login page with the demo hint
  await expect(page).toHaveURL(/\/login/, { timeout: 30_000 });
  await expect(page.getByText(/Demo mode/).first()).toBeVisible();

  // demo credentials work; DEMO banner + demo data everywhere
  await signIn(page, 'admin', 'Admin@123');
  await expect(page.getByText(/DEMO MODE — sample data/)).toBeVisible();
  await expect(page.getByText(/Contractor dues/i)).toBeVisible();
  await page.goto('/contractors');
  // Farah exists ONLY in the demo dataset (the e2e real seed has no Farah)
  await expect(page.getByText('Farah Stitching Unit').first()).toBeVisible();

  // exit back to real data
  await page.goto('/admin/system');
  await page.getByRole('button', { name: /Exit demo mode/ }).click();
  await expect(page).toHaveURL(/\/login/, { timeout: 30_000 });

  // real data again: no demo banner, e2e-seeded users work, demo contractors absent
  await signIn(page, 'admin', 'Admin@123');
  await expect(page.getByText(/DEMO MODE — sample data/)).toHaveCount(0);
  await page.goto('/contractors');
  await expect(page.getByRole('heading', { name: 'Contractors' })).toBeVisible();
  await expect(page.getByText('Farah Stitching Unit')).toHaveCount(0);
});
