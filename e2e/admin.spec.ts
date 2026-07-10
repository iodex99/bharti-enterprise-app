import { expect, test, type Page } from '@playwright/test';

async function signIn(page: Page, username: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();
}

/** On mobile the sidebar is behind the hamburger; open it before using nav links. */
async function openNav(page: Page) {
  const burger = page.getByRole('button', { name: 'Open menu' });
  if (await burger.isVisible()) await burger.click();
}

test('forced password change flow for a fresh user', async ({ page }) => {
  // seeded per-project so the desktop run doesn't consume the mobile run's user
  const username = `fresh-${test.info().project.name}`;
  await page.goto('/login');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill('Fresh@123');
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Intercepted by the forced-change screen
  await expect(page.getByText(/must set a new password/i)).toBeVisible();
  await page.getByLabel('Current password').fill('Fresh@123');
  await page.getByLabel('New password', { exact: true }).fill('Fresh@1234');
  await page.getByLabel('Confirm new password').fill('Fresh@1234');
  await page.getByRole('button', { name: 'Save new password' }).click();
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();
});

test('admin manages users', async ({ page }) => {
  await signIn(page, 'admin', 'Admin@123');
  await openNav(page);
  await page.getByRole('link', { name: 'Users' }).click();
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();

  const username = `e2e-${test.info().project.name}`;
  await page.getByRole('button', { name: '+ New user' }).click();
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Full name').fill('E2E User');
  await page.getByLabel('Temporary password').fill('E2epass123');
  await page.getByRole('button', { name: 'Create user' }).click();
  await expect(page.getByText(`@${username}`)).toBeVisible();
});

test('operator cannot see admin nav or open admin pages', async ({ page }) => {
  await signIn(page, 'operator', 'Operator@123');
  await openNav(page);
  await expect(page.getByRole('link', { name: 'Users' })).toHaveCount(0);
  await page.goto('/admin/users');
  // bounced back home
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();
});

test('owner is read-only: no admin sections', async ({ page }) => {
  await signIn(page, 'owner', 'Owner@123');
  await openNav(page);
  await expect(page.getByRole('link', { name: 'Backups' })).toHaveCount(0);
});
