import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { config } from '../config';
import { isNewerVersion } from '@shared';
import { getDb } from '../db/connection';
import { EXIT_APPLY_UPDATE, gracefulExit } from '../lifecycle';
import { idleSeconds } from './activity';
import {
  expectedHashFor,
  isBusy,
  parseReleaseResponse,
  type ReleaseInfo,
  type UpdateState,
} from './update.helpers';

/**
 * App side of the self-update flow. The app downloads/verifies/stages the new release
 * while still serving, then exits with code 42; the supervisor applies the staged
 * release (see supervisor/supervisor.cjs).
 */

/**
 * Releases are published to a small PUBLIC repo (ADR-042) so the office PC needs no
 * credentials at all — nothing to create at install time and nothing that expires
 * silently later. BHARTI_REPO still overrides it for drills and for anyone who kept the
 * old private-repo setup; a token is honoured when present but is no longer required.
 */
const REPO =
  process.env.BHARTI_REPO ?? process.env.BHARTI_RELEASES_REPO ?? 'iodex99/bharti-releases';
const FEED_URL = process.env.UPDATE_FEED_URL; // mock feed for drills/tests
// Optional PAT — only needed if releases are kept in a private repo.
const GITHUB_TOKEN = process.env.BHARTI_GITHUB_TOKEN ?? '';
const SUPERVISED = process.env.BHARTI_SUPERVISED === '1' && !!process.env.BHARTI_ROOT;
const ROOT = process.env.BHARTI_ROOT ?? '';

/**
 * The PC and Android lines share one releases repo, so pick OUR zip by name rather than
 * taking whichever .zip comes first — a PC server must never install `web-bundle-*.zip`.
 * The mock feed used by the update drill names its asset freely, so it opts out.
 */
const PC_ZIP = /^bharti-app-v.*\.zip$/i;

function ghHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': 'bharti-app', ...extra };
  if (GITHUB_TOKEN && !FEED_URL) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  return headers;
}

type StatusPayload = {
  state: UpdateState;
  detail?: string;
  fromVersion?: string;
  toVersion?: string;
  version?: string;
  at: string;
  writer: 'app' | 'supervisor';
};

let memoryStatus: StatusPayload | null = null;
let latestKnown: ReleaseInfo | null = null;
let lastCheckedAt: string | null = null;
let updateRunning = false;

function statusFile(): string {
  return path.join(ROOT, 'update-status.json');
}

function pendingFile(): string {
  return path.join(ROOT, 'pending-update.json');
}

function writeStatus(state: UpdateState, extra: Partial<StatusPayload> = {}): void {
  memoryStatus = { state, ...extra, at: new Date().toISOString(), writer: 'app' };
  if (!SUPERVISED) return;
  try {
    const tmp = `${statusFile()}.tmp-app`;
    fs.writeFileSync(tmp, JSON.stringify(memoryStatus, null, 2));
    fs.renameSync(tmp, statusFile());
  } catch {
    /* status file is best-effort */
  }
}

function readStatusFile(): StatusPayload | null {
  if (!SUPERVISED) return null;
  try {
    return JSON.parse(fs.readFileSync(statusFile(), 'utf8')) as StatusPayload;
  } catch {
    return null;
  }
}

export function getUpdateStatus(): {
  state: UpdateState;
  detail?: string;
  fromVersion?: string;
  toVersion?: string;
  at?: string;
  current: string;
  supervised: boolean;
  latest: string | null;
  updateAvailable: boolean;
  notes: string;
  lastCheckedAt: string | null;
  autoUpdate: boolean;
  autoUpdateIdleMinutes: number;
  idleSeconds: number;
} {
  // While this process is actively working, its in-memory state wins; otherwise the
  // file (which the supervisor updates across restarts) is the truth.
  const fileStatus = readStatusFile();
  const active = memoryStatus && isBusy(memoryStatus.state) ? memoryStatus : null;
  const effective = active ?? fileStatus ?? memoryStatus;
  const auto = autoUpdateConfig();
  return {
    state: effective?.state ?? 'idle',
    detail: effective?.detail,
    fromVersion: effective?.fromVersion,
    toVersion: effective?.toVersion,
    at: effective?.at,
    current: config.version,
    supervised: SUPERVISED,
    latest: latestKnown?.version ?? null,
    updateAvailable: latestKnown ? isNewerVersion(latestKnown.version, config.version) : false,
    notes: latestKnown?.notes ?? '',
    lastCheckedAt,
    autoUpdate: auto.enabled,
    autoUpdateIdleMinutes: auto.idleMinutes,
    idleSeconds: idleSeconds(),
  };
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: ghHeaders({ Accept: 'application/vnd.github+json' }) });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

export async function checkForUpdate(): Promise<ReturnType<typeof getUpdateStatus>> {
  const url = FEED_URL
    ? `${FEED_URL.replace(/\/$/, '')}/latest.json`
    : `https://api.github.com/repos/${REPO}/releases/latest`;
  try {
    // The mock feed publishes a single, freely-named zip; the real feed is shared with
    // the Android line and must be filtered to our own asset.
    const release = parseReleaseResponse(
      await fetchJson(url),
      FEED_URL ? {} : { zipMatch: PC_ZIP },
    );
    if (release) {
      latestKnown = release;
      lastCheckedAt = new Date().toISOString();
    }
  } catch (err) {
    // Offline or GitHub unreachable — not an error state, just no banner.
    console.warn(`[update] check failed: ${(err as Error).message}`);
  }
  return getUpdateStatus();
}

// ---------------------------------------------------------------------------
// Automatic updates (ADR-043)
//
// The office has no technical staff, so waiting for an admin to notice a banner and
// press a button meant real installs sat months behind. The PC now applies updates by
// itself — but only at a quiet moment, because applying one restarts the server and
// anything half-typed in a form would be lost. "Quiet" is defined by real user
// activity, not the clock: offices keep their own hours.
//
// Everything that made the manual path safe still applies: the supervisor backs the
// database up first, health-gates the new version and rolls back automatically.
// ---------------------------------------------------------------------------

const DEFAULT_IDLE_MINUTES = 3;

/** Reads a setting without letting a DB problem break the update loop. */
function setting(key: string): string | null {
  try {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

export function autoUpdateConfig(): { enabled: boolean; idleMinutes: number } {
  const enabled = (setting('auto_update') ?? 'on') !== 'off';
  const raw = Number(setting('auto_update_idle_minutes') ?? DEFAULT_IDLE_MINUTES);
  const idleMinutes = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_IDLE_MINUTES;
  return { enabled, idleMinutes };
}

/**
 * Apply a pending update if the office is quiet. Returns why it declined, for the log
 * and for the admin's System Health panel.
 */
export function maybeAutoUpdate(): { applied: boolean; reason: string } {
  if (!SUPERVISED) return { applied: false, reason: 'not supervised' };
  if (updateRunning) return { applied: false, reason: 'already updating' };
  if (!latestKnown || !isNewerVersion(latestKnown.version, config.version)) {
    return { applied: false, reason: 'up to date' };
  }
  const { enabled, idleMinutes } = autoUpdateConfig();
  if (!enabled) return { applied: false, reason: 'auto-update turned off' };

  const idle = idleSeconds();
  if (idle < idleMinutes * 60) {
    return { applied: false, reason: `waiting for a quiet moment (idle ${idle}s)` };
  }

  console.log(`[update] applying ${latestKnown.version} automatically (idle ${idle}s)`);
  const result = startUpdate(() => {
    setTimeout(() => gracefulExit(EXIT_APPLY_UPDATE), 300);
  });
  return result.ok
    ? { applied: true, reason: 'applying' }
    : { applied: false, reason: result.error };
}

export function startUpdatePolling(): void {
  // Default one minute: a push should reach the office as soon as CI finishes, and an
  // authenticated GitHub poll at this rate is ~60 of the 5000 requests allowed per hour.
  const minutes = Number(process.env.UPDATE_POLL_MINUTES ?? 1);
  if (!minutes || Number.isNaN(minutes)) return;
  const tick = async (): Promise<void> => {
    await checkForUpdate();
    const outcome = maybeAutoUpdate();
    if (!outcome.applied && outcome.reason.startsWith('waiting')) {
      console.log(`[update] ${latestKnown?.version ?? 'update'} ready — ${outcome.reason}`);
    }
  };
  void tick();
  setInterval(() => void tick(), minutes * 60 * 1000).unref();
}

export type StartUpdateResult =
  | { ok: true }
  | { ok: false; code: number; error: string };

/** Kick off download → verify → stage → exit(42). Runs async; caller polls status. */
export function startUpdate(onReadyToRestart: () => void): StartUpdateResult {
  if (!SUPERVISED) {
    return { ok: false, code: 400, error: 'Not running under the supervisor (dev mode).' };
  }
  if (updateRunning) {
    return { ok: false, code: 409, error: 'An update is already in progress.' };
  }
  if (!latestKnown || !isNewerVersion(latestKnown.version, config.version)) {
    return { ok: false, code: 400, error: 'No newer version available.' };
  }
  updateRunning = true;
  const release = latestKnown;
  void runUpdate(release, onReadyToRestart).catch((err: Error) => {
    updateRunning = false;
    console.error('[update] failed:', err);
    writeStatus('failed', { detail: err.message, toVersion: release.version });
  });
  return { ok: true };
}

async function runUpdate(release: ReleaseInfo, onReadyToRestart: () => void): Promise<void> {
  const version = release.version;
  const releasesDir = path.join(ROOT, 'releases');
  const tmpDir = path.join(ROOT, 'tmp');
  const targetDir = path.join(releasesDir, version);
  const zipPath = path.join(tmpDir, `${version}.zip`);

  writeStatus('downloading', { toVersion: version, fromVersion: config.version });
  fs.mkdirSync(tmpDir, { recursive: true });
  // Private repos require the API asset URL + octet-stream Accept; direct URL otherwise.
  const zipDownloadUrl = GITHUB_TOKEN && release.zipApiUrl ? release.zipApiUrl : release.zipUrl;
  await downloadTo(zipDownloadUrl, zipPath);

  writeStatus('verifying', { toVersion: version, fromVersion: config.version });
  const checksumsDownloadUrl =
    GITHUB_TOKEN && release.checksumsApiUrl ? release.checksumsApiUrl : release.checksumsUrl;
  if (checksumsDownloadUrl) {
    const checksumsRes = await fetch(checksumsDownloadUrl, {
      headers: ghHeaders({ Accept: 'application/octet-stream' }),
    });
    if (!checksumsRes.ok) throw new Error(`checksums download failed: ${checksumsRes.status}`);
    const checksums = await checksumsRes.text();
    const expected = expectedHashFor(checksums, release.zipName);
    const actual = await sha256File(zipPath);
    if (!expected) throw new Error(`checksums.txt has no entry for ${release.zipName}`);
    if (expected !== actual) {
      fs.rmSync(zipPath, { force: true });
      throw new Error('Checksum mismatch — download corrupted, aborting.');
    }
  }

  // Extract to the immutable release dir. Windows ships bsdtar (tar.exe) which reads zips.
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
  await extractZip(zipPath, targetDir);
  fs.rmSync(zipPath, { force: true });

  // Sanity: staged release must self-identify with the same version and be runnable.
  const stagedVersionFile = path.join(targetDir, 'version.json');
  const stagedEntry = path.join(targetDir, 'server', 'dist', 'index.js');
  if (!fs.existsSync(stagedEntry)) throw new Error('Staged release is missing server/dist/index.js');
  const staged = JSON.parse(fs.readFileSync(stagedVersionFile, 'utf8')) as { version?: string };
  if (`v${staged.version}` !== version && staged.version !== version) {
    throw new Error(`Staged version.json (${staged.version}) does not match release tag (${version})`);
  }

  const tmp = `${pendingFile()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version, requestedAt: new Date().toISOString() }));
  fs.renameSync(tmp, pendingFile());
  writeStatus('staged', { toVersion: version, fromVersion: config.version });

  // Hand over: drain HTTP + close DB, then exit(42) so the supervisor applies it.
  writeStatus('restarting', { toVersion: version, fromVersion: config.version });
  onReadyToRestart();
}

async function downloadTo(url: string, dest: string): Promise<void> {
  const res = await fetch(url, {
    headers: ghHeaders({ Accept: 'application/octet-stream' }),
    redirect: 'follow',
  });
  if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status} ${url}`);
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), fs.createWriteStream(dest));
}

async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

function extractZip(zipPath: string, targetDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // bsdtar: Windows 10+ ships it as System32\tar.exe (explicit path — PATH may point at
    // Git's GNU tar, which cannot read zips); on Linux/macOS use unzip.
    const isWin = process.platform === 'win32';
    const cmd = isWin
      ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'unzip';
    const args = isWin ? ['-xf', zipPath, '-C', targetDir] : ['-o', '-q', zipPath, '-d', targetDir];
    const proc = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    proc.on('error', reject);
    proc.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`extract failed (${code}): ${stderr.slice(0, 400)}`)),
    );
  });
}
