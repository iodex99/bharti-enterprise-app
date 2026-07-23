import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 8788);
const APP_PORT = Number(process.env.E2E_APP_PORT ?? 8789);

/**
 * Two suites, two hosts:
 *
 *  - desktop / mobile — the browser client against the Node server (unchanged).
 *  - app             — the Android bundle, served as static files and running its own
 *                      in-app server. Chromium here is the same engine as the Android
 *                      System WebView, so this suite exercises the real thing: SQLite in
 *                      WebAssembly, the routes running in a worker, and the update flow
 *                      against a mock release feed.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      testIgnore: /app-mode\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile',
      testIgnore: /app-mode\.spec\.ts/,
      use: { ...devices['Pixel 7'] },
    },
    {
      name: 'app',
      testMatch: /app-mode\.spec\.ts/,
      use: { ...devices['Pixel 7'], baseURL: `http://localhost:${APP_PORT}` },
    },
  ],
  webServer: [
    {
      command: 'node scripts/e2e-server.mjs',
      port: PORT,
      reuseExistingServer: false,
      env: {
        PORT: String(PORT),
        NODE_ENV: 'production',
        DATA_DIR: process.env.E2E_DATA_DIR ?? './.e2e-data',
        UPDATE_POLL_MINUTES: '0', // no scheduled polling during E2E
        UPDATE_FEED_URL: 'http://127.0.0.1:1', // banner checks fail fast, never hit GitHub
        LOGIN_MAX_PER_MINUTE: '1000', // both browser projects share one server IP
      },
    },
    {
      // Built here so the app suite can never run against a stale bundle.
      command: 'npm run build:app && node scripts/app-server.mjs',
      port: APP_PORT,
      reuseExistingServer: false,
      timeout: 180_000,
      env: { APP_PORT: String(APP_PORT) },
    },
  ],
});
