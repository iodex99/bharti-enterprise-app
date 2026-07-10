import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 8788);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  timeout: 30_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
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
});
