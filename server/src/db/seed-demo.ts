/**
 * CLI wrapper for the demo dataset — for developers/demos from a checkout.
 * (The office app has the same capability as buttons: Admin → System Health → Demo mode.)
 *
 *   npm run seed:demo   # (re)build the demo database at <repo>/data-demo
 *   npm run dev:demo    # run the app against it — sign in: admin / Admin@123
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// MUST happen before any app import (config reads env at import time)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
process.env.DATA_DIR ??= path.join(repoRoot, 'data');
const realDataDir = path.resolve(process.env.DATA_DIR);
const demoDataDir = `${realDataDir}-demo`;

fs.rmSync(demoDataDir, { recursive: true, force: true });
fs.mkdirSync(demoDataDir, { recursive: true });

const { openDatabase } = await import('./connection');
const { migrate } = await import('./migrate');
const { populateDemo } = await import('./demo-data');

const db = openDatabase(path.join(demoDataDir, 'app.db'));
migrate(db);
const recon = populateDemo(db);

const totals = db
  .prepare('SELECT stage, SUM(qty) AS q FROM stock_ledger GROUP BY stage ORDER BY stage')
  .all() as Array<{ stage: string; q: number }>;
console.log('\n[demo] stock by stage:');
for (const t of totals) console.log(`  ${t.stage.padEnd(9)} ${t.q}${t.stage === 'RAW' ? ' cm' : ' pcs'}`);
console.log('\n[demo] reconciliation:');
for (const c of recon.checks) console.log(`  ${c.ok ? 'OK ' : 'FAIL'} ${c.name} — ${c.detail}`);
db.close();

if (!recon.ok) {
  console.error('\n[demo] RECONCILIATION FAILED — the seed found a real bug.');
  process.exit(1);
}
console.log(`\n[demo] demo database ready at ${demoDataDir}`);
console.log('[demo] run it with:  npm run dev:demo   (sign in: admin / Admin@123)');
