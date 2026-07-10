#!/usr/bin/env node
/**
 * Bharti supervisor — zero-dependency process manager for the office machine.
 *
 * Installed ONCE (wrapped by a WinSW Windows service); never auto-updated. It must
 * survive any app-release bug, so it uses only Node built-ins and defensive IO.
 *
 * Directory layout (ROOT = parent of this file's folder):
 *   ROOT/current.txt            active release pointer, e.g. "v1.0.43"
 *   ROOT/releases/<version>/    immutable release dirs (server/dist, client-dist, node_modules)
 *   ROOT/data/                  app.db, uploads/, backups/  — never touched by updates
 *   ROOT/logs/                  supervisor.log + app.log
 *   ROOT/pending-update.json    written by the app when a new release is staged
 *   ROOT/update-status.json     update state machine, read by the app's /api/system/update-status
 *
 * Protocol:
 *   app exit code 42 + pending-update.json  -> apply staged update (backup DB, flip pointer, health-gate)
 *   app exit code 43                        -> migration/boot failure -> rollback if mid-update
 *   any other non-zero exit                 -> crash-restart with backoff (rollback if crash-looping post-update)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const CURRENT_FILE = path.join(ROOT, 'current.txt');
const PENDING_FILE = path.join(ROOT, 'pending-update.json');
const STATUS_FILE = path.join(ROOT, 'update-status.json');
const RELEASES_DIR = path.join(ROOT, 'releases');
const DATA_DIR = path.join(ROOT, 'data');
const LOGS_DIR = path.join(ROOT, 'logs');

const DEFAULT_CONFIG = {
  port: 8787,
  healthTimeoutMs: 60000,
  healthIntervalMs: 2000,
  postUpdateWindowMs: 120000,
  maxPostUpdateCrashes: 3,
  keepReleases: 3,
};

const config = loadConfig();

let child = null;
let shuttingDown = false;
let backoffIndex = 0;
const BACKOFF_SECONDS = [1, 2, 4, 8, 16, 30];
/** Set while a just-applied update is on probation; enables automatic rollback. */
let updateContext = null;

function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOGS_DIR, 'supervisor.log'), line + '\n');
  } catch {
    /* logging must never kill the supervisor */
  }
}

function writeStatus(status) {
  const payload = { ...status, at: new Date().toISOString(), writer: 'supervisor' };
  try {
    atomicWrite(STATUS_FILE, JSON.stringify(payload, null, 2));
  } catch (err) {
    log(`WARN could not write status file: ${err.message}`);
  }
}

function atomicWrite(file, content) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function readCurrentVersion() {
  try {
    const v = fs.readFileSync(CURRENT_FILE, 'utf8').trim();
    if (v) return v;
  } catch {
    /* fallthrough */
  }
  return null;
}

function writeCurrentVersion(version) {
  atomicWrite(CURRENT_FILE, version + '\n');
}

function releaseEntry(version) {
  return path.join(RELEASES_DIR, version, 'server', 'dist', 'index.js');
}

function releaseIsRunnable(version) {
  try {
    return fs.existsSync(releaseEntry(version));
  } catch {
    return false;
  }
}

function normalize(v) {
  return String(v || '').replace(/^v/i, '').trim();
}

function compareVersions(a, b) {
  const pa = normalize(a).split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = normalize(b).split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

// ---------- DB backup / restore (app is stopped whenever these run) ----------

const DB_FILES = ['app.db', 'app.db-wal', 'app.db-shm'];

function backupDatabase(tag) {
  const dest = path.join(DATA_DIR, 'backups', `pre-update-${tag}`);
  fs.mkdirSync(dest, { recursive: true });
  let copied = 0;
  for (const name of DB_FILES) {
    const src = path.join(DATA_DIR, name);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(dest, name));
      copied++;
    }
  }
  log(`database backup -> ${dest} (${copied} files)`);
  return dest;
}

function restoreDatabase(backupDir) {
  if (!backupDir || !fs.existsSync(backupDir)) {
    log('WARN no backup dir to restore; leaving database as-is (migrations are additive-only)');
    return;
  }
  for (const name of DB_FILES) {
    const dest = path.join(DATA_DIR, name);
    try {
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
    } catch (err) {
      log(`WARN could not remove ${name}: ${err.message}`);
    }
  }
  for (const name of DB_FILES) {
    const src = path.join(backupDir, name);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(DATA_DIR, name));
  }
  log(`database restored from ${backupDir}`);
}

// ---------- health check ----------

function checkHealth(expectedVersion) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: config.port, path: '/api/system/health', timeout: 3000 },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            const versionOk =
              !expectedVersion || normalize(json.version) === normalize(expectedVersion);
            resolve(res.statusCode === 200 && json.ok === true && versionOk);
          } catch {
            resolve(false);
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

async function waitHealthy(expectedVersion, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shuttingDown) return false;
    if (child && child.exitCode !== null) return false; // died while waiting
    if (await checkHealth(expectedVersion)) return true;
    await sleep(config.healthIntervalMs);
  }
  return false;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- release pruning ----------

function pruneReleases(currentVersion) {
  try {
    const dirs = fs
      .readdirSync(RELEASES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort(compareVersions)
      .reverse(); // newest first
    const keep = new Set(dirs.slice(0, config.keepReleases));
    keep.add(currentVersion);
    for (const dir of dirs) {
      if (!keep.has(dir)) {
        fs.rmSync(path.join(RELEASES_DIR, dir), { recursive: true, force: true });
        log(`pruned old release ${dir}`);
      }
    }
  } catch (err) {
    log(`WARN prune failed: ${err.message}`);
  }
}

// ---------- app process ----------

function startApp(version) {
  const entry = releaseEntry(version);
  log(`starting app ${version} (${entry})`);
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const appLog = fs.openSync(path.join(LOGS_DIR, 'app.log'), 'a');
  child = spawn(process.execPath, [entry], {
    cwd: path.join(RELEASES_DIR, version),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(config.port),
      DATA_DIR,
      BHARTI_ROOT: ROOT,
      BHARTI_SUPERVISED: '1',
      // PAT for private-repo release polling/downloads (empty for public repos).
      BHARTI_GITHUB_TOKEN: config.githubToken || process.env.BHARTI_GITHUB_TOKEN || '',
      ...(config.repo ? { BHARTI_REPO: config.repo } : {}),
    },
    stdio: ['ignore', appLog, appLog],
  });
  const startedAt = Date.now();

  child.on('exit', (code, signal) => {
    fs.closeSync(appLog);
    child = null;
    if (shuttingDown) return;
    const uptime = Date.now() - startedAt;
    log(`app exited code=${code} signal=${signal || 'none'} uptime=${Math.round(uptime / 1000)}s`);
    handleExit(version, code, uptime).catch((err) => {
      log(`FATAL in exit handler: ${err.stack || err.message}`);
      // last-ditch: try to keep something running
      setTimeout(() => startApp(readCurrentVersion() || version), 5000);
    });
  });
}

async function handleExit(version, code, uptimeMs) {
  // 42 = graceful exit requesting a staged update be applied
  if (code === 42 && fs.existsSync(PENDING_FILE)) {
    await applyPendingUpdate(version);
    return;
  }

  // 43 = app refused to boot (migration failure). If we're mid-update, roll back.
  if (code === 43 && updateContext) {
    await rollback('migration or boot failure (exit 43)');
    return;
  }
  if (code === 43) {
    log('boot failure (exit 43) outside an update; retrying in 60s — manual intervention likely needed');
    writeStatus({ state: 'failed', detail: 'App fails to boot (exit 43). Check logs/app.log.' });
    await sleep(60000);
    startApp(readCurrentVersion() || version);
    return;
  }

  // Crash while a fresh update is on probation -> count towards rollback.
  if (updateContext) {
    updateContext.crashes += 1;
    const withinWindow = Date.now() - updateContext.appliedAt < config.postUpdateWindowMs;
    if (withinWindow && updateContext.crashes >= config.maxPostUpdateCrashes) {
      await rollback(`crashed ${updateContext.crashes}x within post-update window`);
      return;
    }
    if (!withinWindow) updateContext = null; // probation over
  }

  // Plain crash: restart with backoff.
  if (uptimeMs > 60000) backoffIndex = 0;
  const delay = BACKOFF_SECONDS[Math.min(backoffIndex, BACKOFF_SECONDS.length - 1)] * 1000;
  backoffIndex++;
  log(`restarting in ${delay / 1000}s`);
  await sleep(delay);
  if (!shuttingDown) startApp(readCurrentVersion() || version);
}

// ---------- update application & rollback ----------

async function applyPendingUpdate(previousVersion) {
  let pending;
  try {
    pending = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
  } catch (err) {
    log(`pending-update.json unreadable (${err.message}); restarting current version`);
    safeUnlink(PENDING_FILE);
    writeStatus({ state: 'failed', detail: 'Staged update file was unreadable.' });
    startApp(previousVersion);
    return;
  }
  safeUnlink(PENDING_FILE);
  const newVersion = String(pending.version || '').trim();

  if (!newVersion || !releaseIsRunnable(newVersion)) {
    log(`staged release ${newVersion || '(missing)'} is not runnable; restarting ${previousVersion}`);
    writeStatus({ state: 'failed', detail: `Staged release ${newVersion} is missing or incomplete.` });
    startApp(previousVersion);
    return;
  }

  log(`applying update ${previousVersion || '(none)'} -> ${newVersion}`);
  writeStatus({ state: 'restarting', fromVersion: previousVersion, toVersion: newVersion });

  const backupDir = backupDatabase(newVersion);
  updateContext = {
    previousVersion,
    newVersion,
    backupDir,
    appliedAt: Date.now(),
    crashes: 0,
  };
  writeCurrentVersion(newVersion);
  startApp(newVersion);

  writeStatus({ state: 'finalizing', fromVersion: previousVersion, toVersion: newVersion });
  const healthy = await waitHealthy(newVersion, config.healthTimeoutMs);
  if (healthy) {
    log(`update to ${newVersion} healthy`);
    writeStatus({ state: 'success', version: newVersion, fromVersion: previousVersion });
    pruneReleases(newVersion);
    // Probation continues for postUpdateWindowMs (crash-loop rollback still armed).
    setTimeout(() => {
      if (updateContext && updateContext.newVersion === newVersion) updateContext = null;
    }, config.postUpdateWindowMs).unref();
  } else if (!shuttingDown) {
    await rollback('health check failed after update');
  }
}

async function rollback(reason) {
  const ctx = updateContext;
  updateContext = null;
  if (!ctx) return;
  log(`ROLLBACK (${reason}): ${ctx.newVersion} -> ${ctx.previousVersion}`);

  if (child) {
    try {
      child.kill();
    } catch {
      /* already dead */
    }
    // give it a moment to release file handles (Windows)
    await sleep(1500);
  }

  if (ctx.previousVersion && releaseIsRunnable(ctx.previousVersion)) {
    writeCurrentVersion(ctx.previousVersion);
    restoreDatabase(ctx.backupDir);
    startApp(ctx.previousVersion);
    const healthy = await waitHealthy(ctx.previousVersion, config.healthTimeoutMs);
    writeStatus({
      state: 'rolled_back',
      fromVersion: ctx.newVersion,
      toVersion: ctx.previousVersion,
      detail: `${reason}${healthy ? '' : ' (previous version also unhealthy — check logs)'}`,
    });
  } else {
    // No previous version (first install failed). Keep trying the new one with backoff.
    log('no previous version to roll back to; retrying new version');
    writeStatus({ state: 'failed', detail: `${reason}; no previous version to roll back to.` });
    await sleep(10000);
    startApp(ctx.newVersion);
  }
}

function safeUnlink(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}

// ---------- shutdown ----------

function shutdown(signal) {
  log(`supervisor received ${signal}; stopping app`);
  shuttingDown = true;
  if (child) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => process.exit(0), 4000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ---------- main ----------

async function main() {
  fs.mkdirSync(RELEASES_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  log(`supervisor starting (root=${ROOT}, port=${config.port})`);

  let version = readCurrentVersion();

  // A pending update left behind (power loss mid-flow, or manually dropped) is applied on boot.
  if (fs.existsSync(PENDING_FILE)) {
    log('pending update found at boot');
    await applyPendingUpdate(version);
    return;
  }

  if (!version || !releaseIsRunnable(version)) {
    // Try to self-heal: pick the newest runnable release.
    const candidates = fs.existsSync(RELEASES_DIR)
      ? fs
          .readdirSync(RELEASES_DIR, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
          .filter(releaseIsRunnable)
          .sort(compareVersions)
      : [];
    const fallback = candidates[candidates.length - 1];
    if (!fallback) {
      log(`FATAL no runnable release found in ${RELEASES_DIR}; install a release and restart`);
      writeStatus({ state: 'failed', detail: 'No runnable release installed.' });
      process.exit(1);
    }
    log(`current.txt invalid (${version}); falling back to ${fallback}`);
    version = fallback;
    writeCurrentVersion(version);
  }

  startApp(version);
}

main().catch((err) => {
  log(`FATAL ${err.stack || err.message}`);
  process.exit(1);
});
