/**
 * Playwright webServer entrypoint: wipe + seed the E2E database, THEN boot the
 * production server in-process. Doing all three in one command avoids the race
 * between Playwright's webServer launch and globalSetup on Windows file locks.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const dataDir = path.resolve(process.env.DATA_DIR ?? './.e2e-data');

for (let attempt = 0; ; attempt++) {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
    break;
  } catch (err) {
    if (attempt >= 4) throw err;
    await new Promise((r) => setTimeout(r, 500)); // Windows: stale handle from a previous run
  }
}
fs.mkdirSync(dataDir, { recursive: true });

execSync('npx tsx server/src/db/seed.ts --force', {
  stdio: 'inherit',
  env: { ...process.env, DATA_DIR: dataDir },
});

await import('../server/dist/index.js');
