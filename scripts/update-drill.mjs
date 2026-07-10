/**
 * End-to-end drill of the self-update pipeline, run locally (Windows).
 *
 * Simulates the office machine in .local-releases/sandbox and a GitHub-like feed on
 * localhost, then verifies:
 *   1. supervisor boots release v9.0.1 (real seeded SQLite DB) and serves health
 *   2. admin signs in; app sees v9.0.2 on the feed; one-click update: download, verify,
 *      stage, exit 42; supervisor applies it; status reaches "success"; DB data intact
 *   3. a poisoned v9.0.3 (exits 43 on boot) AUTO-ROLLS-BACK to v9.0.2 with DB restore
 *
 * Usage: npm run build && node scripts/update-drill.mjs
 */
import { execSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = path.join(repoRoot, '.local-releases', 'sandbox');
const FEED_DIR = path.join(repoRoot, '.local-releases', 'feed');
const PORT = 8791;
const FEED_PORT = 8792;
// Windows' bundled bsdtar — PATH may resolve `tar` to Git's GNU tar, which lacks zip support.
const BSDTAR = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');

const steps = [];
let cookie = '';

function step(name, ok, detail = '') {
  steps.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) finish(1);
}

function finish(code) {
  for (const p of processes) {
    try {
      p.kill();
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => process.exit(code), 500);
  throw new Error(code === 0 ? 'DRILL_DONE' : 'DRILL_FAILED');
}

const processes = [];

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { headers: cookie ? { Cookie: cookie, ...opts.headers } : opts.headers, ...opts });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function waitFor(fn, timeoutMs, everyMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  if (lastErr) console.error('waitFor last error:', lastErr.message);
  return null;
}

function packageVersion(version) {
  execSync(`node scripts/package-release.mjs ${version} --out "${path.join(FEED_DIR, version)}"`, {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}

function extractRelease(version, dest) {
  fs.mkdirSync(dest, { recursive: true });
  execSync(
    `"${BSDTAR}" -xf "${path.join(FEED_DIR, version, `bharti-app-v${version}.zip`)}" -C "${dest}"`,
  );
}

function publishToFeed(version) {
  const zipName = `bharti-app-v${version}.zip`;
  const latest = {
    tag_name: `v${version}`,
    body: `drill release ${version}`,
    published_at: new Date().toISOString(),
    assets: [
      { name: zipName, browser_download_url: `http://127.0.0.1:${FEED_PORT}/${version}/${zipName}` },
      {
        name: 'checksums.txt',
        browser_download_url: `http://127.0.0.1:${FEED_PORT}/${version}/checksums.txt`,
      },
    ],
  };
  fs.writeFileSync(path.join(FEED_DIR, 'latest.json'), JSON.stringify(latest, null, 2));
}

function startFeedServer() {
  const server = http.createServer((req, res) => {
    const file = path.join(FEED_DIR, decodeURIComponent(req.url.replace(/^\//, '')));
    if (!file.startsWith(FEED_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('nope');
      return;
    }
    res.writeHead(200);
    fs.createReadStream(file).pipe(res);
  });
  server.listen(FEED_PORT, '127.0.0.1');
  return server;
}

function startSupervisor() {
  const proc = spawn(process.execPath, [path.join(SANDBOX, 'supervisor', 'supervisor.cjs')], {
    env: {
      ...process.env,
      UPDATE_FEED_URL: `http://127.0.0.1:${FEED_PORT}`,
      UPDATE_POLL_MINUTES: '0.05', // ~3s
      LOGIN_MAX_PER_MINUTE: '1000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (c) => process.stdout.write(`  [sup] ${c}`));
  proc.stderr.on('data', (c) => process.stderr.write(`  [sup!] ${c}`));
  processes.push(proc);
  return proc;
}

async function login() {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Admin@123' }),
  });
  if (!res.ok) throw new Error(`login -> ${res.status}`);
  const setCookie = res.headers.get('set-cookie') ?? '';
  cookie = setCookie.split(';')[0];
  return cookie;
}

function readMarker() {
  // Read-only peek while the app may be running (WAL allows concurrent readers).
  const db = new Database(path.join(SANDBOX, 'data', 'app.db'), { readonly: true });
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'drill_marker'").get();
    return row ? row.value : null;
  } finally {
    db.close();
  }
}

function writeMarker(value) {
  const db = new Database(path.join(SANDBOX, 'data', 'app.db'));
  try {
    db.pragma('busy_timeout = 5000');
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('drill_marker', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(value);
  } finally {
    db.close();
  }
}

async function waitForTerminalStatus(timeoutMs) {
  return waitFor(async () => {
    const s = await fetchJson(`http://127.0.0.1:${PORT}/api/system/update-status`);
    return ['success', 'failed', 'rolled_back'].includes(s.state) ? s : null;
  }, timeoutMs, 1500);
}

async function main() {
  // ---------- setup ----------
  fs.rmSync(path.join(repoRoot, '.local-releases'), { recursive: true, force: true });
  fs.mkdirSync(SANDBOX, { recursive: true });
  fs.mkdirSync(FEED_DIR, { recursive: true });

  console.log('\n== packaging drill releases (runs npm ci twice, be patient) ==');
  packageVersion('9.0.1');
  packageVersion('9.0.2');

  // Poisoned v9.0.3: same as 9.0.2 but the server entry exits 43 immediately.
  const poisonDir = path.join(FEED_DIR, 'poison-staging');
  extractRelease('9.0.2', poisonDir);
  fs.writeFileSync(
    path.join(poisonDir, 'server', 'dist', 'index.js'),
    "console.error('drill: poisoned release, refusing to boot'); process.exit(43);\n",
  );
  fs.writeFileSync(
    path.join(poisonDir, 'version.json'),
    JSON.stringify({ version: '9.0.3', sha: 'poison', builtAt: new Date().toISOString() }),
  );
  const poisonOut = path.join(FEED_DIR, '9.0.3');
  fs.mkdirSync(poisonOut, { recursive: true });
  const poisonZip = path.join(poisonOut, 'bharti-app-v9.0.3.zip');
  execSync(`"${BSDTAR}" -a -cf "${poisonZip}" -C "${poisonDir}" .`);
  fs.writeFileSync(
    path.join(poisonOut, 'checksums.txt'),
    `${sha256(poisonZip)}  bharti-app-v9.0.3.zip\n`,
  );
  fs.rmSync(poisonDir, { recursive: true, force: true });

  // Sandbox: supervisor + v9.0.1 installed, current.txt set, REAL seeded database.
  fs.mkdirSync(path.join(SANDBOX, 'supervisor'), { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, 'supervisor', 'supervisor.cjs'),
    path.join(SANDBOX, 'supervisor', 'supervisor.cjs'),
  );
  fs.writeFileSync(
    path.join(SANDBOX, 'supervisor', 'config.json'),
    JSON.stringify({ port: PORT, healthTimeoutMs: 30000, postUpdateWindowMs: 20000 }),
  );
  extractRelease('9.0.1', path.join(SANDBOX, 'releases', 'v9.0.1'));
  fs.writeFileSync(path.join(SANDBOX, 'current.txt'), 'v9.0.1\n');

  console.log('\n== seeding sandbox database ==');
  execSync('npx tsx server/src/db/seed.ts --force', {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, DATA_DIR: path.join(SANDBOX, 'data'), NODE_ENV: 'test' },
  });
  writeMarker('marker-v1');

  const feed = startFeedServer();
  processes.push({ kill: () => feed.close() });

  // ---------- drill 1: boot ----------
  console.log('\n== drill 1: supervisor boots v9.0.1 ==');
  publishToFeed('9.0.1'); // no update available yet
  startSupervisor();
  const health1 = await waitFor(
    () => fetchJson(`http://127.0.0.1:${PORT}/api/system/health`),
    30000,
  );
  step('supervisor boots v9.0.1 healthy', health1?.ok === true && health1?.version === '9.0.1');
  await login();
  step('admin can sign in on the sandbox install', cookie.startsWith('bharti_session='));

  // ---------- drill 2: one-click update ----------
  console.log('\n== drill 2: update to v9.0.2 via the API ==');
  publishToFeed('9.0.2');
  const check = await waitFor(async () => {
    const s = await fetchJson(`http://127.0.0.1:${PORT}/api/system/update-check`);
    return s.updateAvailable ? s : null;
  }, 20000);
  step('app sees v9.0.2 on the feed', !!check, `latest=${check?.latest}`);

  const post = await fetch(`http://127.0.0.1:${PORT}/api/system/update`, {
    method: 'POST',
    headers: { Cookie: cookie },
  });
  step('update accepted for admin', post.status === 202, `status=${post.status}`);

  const health2 = await waitFor(async () => {
    const h = await fetchJson(`http://127.0.0.1:${PORT}/api/system/health`);
    return h.version === '9.0.2' ? h : null;
  }, 90000);
  step('v9.0.2 running after one-click update', !!health2);

  const status2 = await waitForTerminalStatus(60000);
  step('status reaches success', status2?.state === 'success', `state=${status2?.state}`);
  step('session survived the update', (await fetchJson(`http://127.0.0.1:${PORT}/api/auth/me`)).user.username === 'admin');
  step(
    'pre-update DB backup exists',
    fs.existsSync(path.join(SANDBOX, 'data', 'backups', 'pre-update-v9.0.2', 'app.db')),
  );
  step('data survived the update', readMarker() === 'marker-v1');

  // ---------- drill 3: poisoned release auto-rolls back ----------
  console.log('\n== drill 3: poisoned v9.0.3 must auto-rollback ==');
  writeMarker('marker-v2'); // mutate AFTER v9.0.2 so restore-from-backup is provable
  publishToFeed('9.0.3');
  await waitFor(async () => {
    const s = await fetchJson(`http://127.0.0.1:${PORT}/api/system/update-check`);
    return s.updateAvailable ? s : null;
  }, 20000);
  const post3 = await fetch(`http://127.0.0.1:${PORT}/api/system/update`, {
    method: 'POST',
    headers: { Cookie: cookie },
  });
  step('poisoned update accepted', post3.status === 202);

  const rolledBack = await waitFor(async () => {
    const h = await fetchJson(`http://127.0.0.1:${PORT}/api/system/health`);
    if (h.version !== '9.0.2') return null;
    const s = await fetchJson(`http://127.0.0.1:${PORT}/api/system/update-status`);
    return s.state === 'rolled_back' ? s : null;
  }, 120000, 2000);
  step('auto-rollback to v9.0.2 with status=rolled_back', !!rolledBack);
  step('DB restored from pre-update backup', readMarker() === 'marker-v2');
  step(
    'current.txt points at v9.0.2',
    fs.readFileSync(path.join(SANDBOX, 'current.txt'), 'utf8').trim() === 'v9.0.2',
  );

  console.log(
    `\n== DRILL COMPLETE: ${steps.filter((s) => s.ok).length}/${steps.length} steps passed ==`,
  );
  finish(0);
}

main().catch((err) => {
  if (err.message !== 'DRILL_DONE' && err.message !== 'DRILL_FAILED') {
    console.error(err);
    for (const p of processes) {
      try {
        p.kill();
      } catch {
        /* ignore */
      }
    }
    process.exit(1);
  }
});
