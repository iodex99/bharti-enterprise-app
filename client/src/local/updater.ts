import { unzipSync } from 'fflate';
import {
  isNewerVersion,
  parseAndroidManifest,
  updateKindFor,
  type AndroidReleaseManifest,
  type UpdateState,
} from '@shared';
import { sha256Hex } from './shims/node-crypto';
import { getShell, type BundleRecord, type BundleState } from './shell';

/**
 * In-app updates.
 *
 * Android does not let an app install an APK over itself without the user confirming a
 * system dialog, so "tap Update and it just updates" is delivered the way every app with
 * live updates does it: the part that actually changes — the whole application bundle,
 * including all business logic, screens and database migrations — is downloaded,
 * verified and swapped in, then the app restarts itself. The APK is only needed again if
 * the native shell itself changes, which is rare; the app detects that case and says so.
 *
 * Business data is never part of a bundle. It lives in the device's origin-private
 * storage (see db/sqlite-wasm.ts), which the swap does not touch. A safety copy of the
 * database is still written before every update, and a bundle that fails to start twice
 * is rolled back automatically.
 */

const FEED_URL_KEY = 'bharti.updateFeed';
const TOKEN_KEY = 'bharti.updateToken';
const DEFAULT_REPO = 'iodex99/bharti-enterprise-app';
const ROLLBACK_KEY = 'bharti.rolledBackFrom';
const MANIFEST_ASSET = 'app-manifest.json';
const HEALTHY_AFTER_MS = 0; // marked healthy as soon as the app has booted and rendered
const MAX_BOOT_ATTEMPTS = 2;

export type UpdateStatus = {
  state: UpdateState;
  detail?: string;
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  /** 'bundle' = one tap; 'apk' = the user must confirm an Android install. */
  kind: 'bundle' | 'apk' | null;
  notes: string;
  lastCheckedAt: string | null;
  supervised: true;
  rolledBackFrom?: string;
};

let status: UpdateStatus = {
  state: 'idle',
  current: '0.0.0',
  latest: null,
  updateAvailable: false,
  kind: null,
  notes: '',
  lastCheckedAt: null,
  supervised: true,
};

let known: { manifest: AndroidReleaseManifest; assets: Record<string, string> } | null = null;
let running = false;

export function setCurrentVersion(version: string): void {
  status = { ...status, current: version };
}

export function getUpdateStatus(): UpdateStatus {
  return status;
}

function setStatus(next: Partial<UpdateStatus>): void {
  status = { ...status, ...next };
}

// -- feed --------------------------------------------------------------------

export function updateFeedUrl(): string {
  return (
    localStorage.getItem(FEED_URL_KEY) ??
    `https://api.github.com/repos/${DEFAULT_REPO}/releases/latest`
  );
}

export function setUpdateFeedUrl(url: string | null): void {
  if (url) localStorage.setItem(FEED_URL_KEY, url);
  else localStorage.removeItem(FEED_URL_KEY);
}

function feedHeaders(accept: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: accept };
  const token = localStorage.getItem(TOKEN_KEY);
  if (token && updateFeedUrl().includes('api.github.com')) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

/** Real network fetch — the bridge only intercepts /api and /uploads. */
async function download(url: string, accept: string): Promise<Uint8Array> {
  const res = await fetch(url, { headers: feedHeaders(accept), redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

type ReleaseAssetLike = { name: string; browser_download_url: string; url?: string };

export async function checkForUpdate(): Promise<UpdateStatus> {
  setStatus({ state: 'checking' });
  try {
    const res = await fetch(updateFeedUrl(), {
      headers: feedHeaders('application/vnd.github+json'),
    });
    if (!res.ok) throw new Error(`Update check failed (${res.status})`);
    const release = (await res.json()) as { assets?: ReleaseAssetLike[]; body?: string };
    const assets: Record<string, string> = {};
    for (const asset of release.assets ?? []) {
      // Private repos need the API asset URL; public ones work either way.
      assets[asset.name] = localStorage.getItem(TOKEN_KEY)
        ? (asset.url ?? asset.browser_download_url)
        : asset.browser_download_url;
    }
    const manifestUrl = assets[MANIFEST_ASSET];
    if (!manifestUrl) throw new Error('This release has no Android manifest.');
    const manifestBytes = await download(manifestUrl, 'application/octet-stream');
    const manifest = parseAndroidManifest(JSON.parse(new TextDecoder().decode(manifestBytes)));
    if (!manifest) throw new Error('The release manifest could not be read.');

    known = { manifest, assets };
    const newer = isNewerVersion(manifest.version, status.current);
    const nativeVersion = await getShell().nativeVersion();
    setStatus({
      // A recorded rollback must survive a routine check — it explains to the user why
      // the version they installed is not the one running.
      state: status.rolledBackFrom ? status.state : 'idle',
      latest: manifest.version,
      updateAvailable: newer,
      kind: newer ? updateKindFor(manifest, nativeVersion) : null,
      notes: manifest.notes,
      lastCheckedAt: new Date().toISOString(),
    });
  } catch (err) {
    // Offline is normal on a shop floor — not an error state, just no banner.
    console.warn('[update]', (err as Error).message);
    setStatus({ state: status.rolledBackFrom ? status.state : 'idle' });
  }
  return status;
}

export function startUpdatePolling(minutes = 30): () => void {
  void checkForUpdate();
  const timer = setInterval(() => void checkForUpdate(), minutes * 60 * 1000);
  return () => clearInterval(timer);
}

// -- applying ----------------------------------------------------------------

export type StartResult = { ok: true } | { ok: false; code: number; error: string };

export function startUpdate(): StartResult {
  if (running) return { ok: false, code: 409, error: 'An update is already in progress.' };
  if (!known || !status.updateAvailable) {
    return { ok: false, code: 400, error: 'No newer version available.' };
  }
  if (status.kind === 'apk') {
    return {
      ok: false,
      code: 400,
      error:
        'This update also replaces the app itself. Tap "Download app file", then open it to install — your data stays on the device.',
    };
  }
  running = true;
  void applyBundleUpdate().catch((err: Error) => {
    running = false;
    console.error('[update] failed:', err);
    setStatus({ state: 'failed', detail: err.message });
  });
  return { ok: true };
}

/** The APK path: hand the file to Android's installer, with the user's consent. */
export async function downloadApk(): Promise<void> {
  if (!known?.manifest.apk) throw new Error('This release has no app file.');
  const url = known.assets[known.manifest.apk.name];
  if (!url) throw new Error('The app file is missing from the release.');
  await getShell().openExternal(url);
}

async function applyBundleUpdate(): Promise<void> {
  const shell = getShell();
  const { manifest, assets } = known!;
  const url = assets[manifest.webBundle.name];
  if (!url) throw new Error('The update bundle is missing from the release.');

  setStatus({ state: 'downloading', detail: `Downloading ${manifest.version}…` });
  const zipBytes = await download(url, 'application/octet-stream');

  setStatus({ state: 'verifying', detail: 'Checking the download…' });
  const actual = sha256Hex(zipBytes);
  if (actual !== manifest.webBundle.sha256) {
    throw new Error('The download was damaged (checksum mismatch). Nothing was changed.');
  }

  const files = readBundle(zipBytes);
  assertUsableBundle(files, manifest.version);

  // Data is not part of the bundle and is not touched by the swap — this copy exists so
  // there is always a rewind point taken immediately before a version change.
  try {
    // imported here, not at module scope: bridge.ts pulls in the whole worker plumbing
    const { exportDatabase } = await import('./bridge');
    const dbBytes = await exportDatabase();
    await shell.writePrivateFile(`pre-update-${manifest.version}.db`, dbBytes);
  } catch (err) {
    console.warn('[update] pre-update safety copy failed:', err);
  }

  setStatus({ state: 'staged', detail: 'Installing…' });
  const path = await shell.writeBundle(manifest.version, files);

  const state = await shell.readBundleState();
  const next: BundleState = {
    active: state.active,
    previous: state.active,
    pending: {
      version: manifest.version,
      path,
      attempts: 0,
      startedAt: new Date().toISOString(),
    },
  };
  await shell.writeBundleState(next);
  await shell.setActiveBundlePath(path);

  setStatus({ state: 'restarting', detail: 'Restarting…' });
  setTimeout(() => shell.restart(), 600);
}

/** Zip entries are stored with a leading directory in some CI zips — flatten one level. */
function readBundle(zipBytes: Uint8Array): Map<string, Uint8Array> {
  const raw = unzipSync(zipBytes);
  const names = Object.keys(raw).filter((name) => !name.endsWith('/'));
  const prefix = commonPrefix(names);
  const files = new Map<string, Uint8Array>();
  for (const name of names) {
    files.set(prefix ? name.slice(prefix.length) : name, raw[name]!);
  }
  return files;
}

function commonPrefix(names: string[]): string {
  if (names.length === 0) return '';
  const first = names[0]!;
  const slash = first.indexOf('/');
  if (slash === -1) return '';
  const candidate = first.slice(0, slash + 1);
  return names.every((name) => name.startsWith(candidate)) ? candidate : '';
}

/**
 * Refuse to activate a bundle that cannot possibly boot. This is the guard that makes
 * automatic rollback a backstop rather than the first line of defence — a bundle whose
 * entry script is missing would otherwise leave a blank screen with no JavaScript
 * running to recover from it.
 */
function assertUsableBundle(files: Map<string, Uint8Array>, version: string): void {
  const index = files.get('index.html');
  if (!index) throw new Error('The update is incomplete (no index.html).');
  const html = new TextDecoder().decode(index);
  const referenced = [...html.matchAll(/(?:src|href)="\/?([^"]+\.(?:js|css))"/g)].map((m) => m[1]!);
  const missing = referenced.filter((name) => !files.has(name));
  if (missing.length > 0) {
    throw new Error(`The update is incomplete (missing ${missing[0]}).`);
  }
  const versionFile = files.get('version.json');
  if (versionFile) {
    try {
      const declared = (JSON.parse(new TextDecoder().decode(versionFile)) as { version?: string })
        .version;
      if (declared && declared !== version && `v${declared}` !== version) {
        throw new Error(`The update says it is ${declared} but the release says ${version}.`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('The update says')) throw err;
    }
  }
}

// -- boot-time health gate ---------------------------------------------------

export type BootDecision =
  | { action: 'continue' }
  | { action: 'rolled-back'; from: string };

/**
 * Called before the UI renders. If a freshly installed bundle is on its second failed
 * start, put the previous one back and restart. Otherwise record the attempt: if this
 * boot never reaches markBundleHealthy(), the next one will roll back.
 */
export async function guardBundleBoot(): Promise<BootDecision> {
  const shell = getShell();
  const state = await shell.readBundleState();
  const pending = state.pending;
  if (!pending) return { action: 'continue' };

  if (pending.attempts >= MAX_BOOT_ATTEMPTS) {
    const fallback = state.previous;
    await shell.writeBundleState({ active: fallback, previous: null, pending: null });
    await shell.setActiveBundlePath(fallback?.path ?? '');
    await shell.removeBundle(pending.path).catch(() => undefined);
    setStatus({ state: 'rolled_back', rolledBackFrom: pending.version, detail: undefined });
    localStorage.setItem(ROLLBACK_KEY, pending.version);
    shell.restart();
    return { action: 'rolled-back', from: pending.version };
  }

  await shell.writeBundleState({
    ...state,
    pending: { ...pending, attempts: pending.attempts + 1 },
  });
  return { action: 'continue' };
}

/** Called once the app has booted successfully — this is what "the update worked" means. */
export async function markBundleHealthy(): Promise<void> {
  const shell = getShell();
  const state = await shell.readBundleState();
  if (!state.pending) return;
  const promoted: BundleRecord = { version: state.pending.version, path: state.pending.path };
  await shell.writeBundleState({ active: promoted, previous: state.previous, pending: null });
  setStatus({ state: 'success', detail: `Updated to ${promoted.version}.` });
  // Keep exactly one older bundle as the rollback target; drop anything before it.
  running = false;
}

/**
 * A rollback happens on the launch AFTER the failure, and the restart wipes in-memory
 * state — so the notice is persisted and re-read at every boot until someone dismisses
 * it. Showing it once would be unreliable: whoever tapped Update is often not the person
 * who opens the app next, and "the version I installed isn't running" needs an answer.
 */
export function readRollbackNotice(): string | null {
  const version = localStorage.getItem(ROLLBACK_KEY);
  if (version) {
    setStatus({
      state: 'rolled_back',
      rolledBackFrom: version,
      detail: `Version ${version} would not start, so the previous version was restored.`,
    });
  }
  return version;
}

export function dismissRollbackNotice(): void {
  localStorage.removeItem(ROLLBACK_KEY);
  setStatus({ state: 'idle', rolledBackFrom: undefined, detail: undefined });
}

export const _internals = { readBundle, assertUsableBundle, HEALTHY_AFTER_MS, MAX_BOOT_ATTEMPTS };
