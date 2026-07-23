/**
 * Pure update-feed helpers, shared by the Node server's supervisor-driven updater and
 * the Android app's in-app updater. No network, no filesystem — unit-tested directly.
 */

export type ReleaseAsset = { name: string; browser_download_url: string; url?: string };

export type ReleaseInfo = {
  version: string;
  zipName: string;
  /** Direct download URL (public repos / mock feed). */
  zipUrl: string;
  /** GitHub API asset URL — required for PRIVATE repos (with Accept: octet-stream + token). */
  zipApiUrl: string | null;
  checksumsUrl: string | null;
  checksumsApiUrl: string | null;
  notes: string;
  publishedAt: string | null;
};

/** Parse a GitHub /releases/latest response (or our mock feed with the same shape). */
export function parseReleaseResponse(json: unknown): ReleaseInfo | null {
  if (!json || typeof json !== 'object') return null;
  const rel = json as {
    tag_name?: string;
    body?: string;
    published_at?: string;
    assets?: ReleaseAsset[];
  };
  if (!rel.tag_name || !Array.isArray(rel.assets)) return null;
  const zip = rel.assets.find((a) => a.name.endsWith('.zip'));
  if (!zip) return null;
  const checksums = rel.assets.find((a) => a.name === 'checksums.txt');
  return {
    version: rel.tag_name.trim(),
    zipName: zip.name,
    zipUrl: zip.browser_download_url,
    zipApiUrl: zip.url ?? null,
    checksumsUrl: checksums?.browser_download_url ?? null,
    checksumsApiUrl: checksums?.url ?? null,
    notes: rel.body ?? '',
    publishedAt: rel.published_at ?? null,
  };
}

/**
 * checksums.txt format: "<sha256-hex>  <filename>" per line (sha256sum style).
 * Returns the expected hash for the given filename, or null.
 */
export function expectedHashFor(checksumsText: string, filename: string): string | null {
  for (const line of checksumsText.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (match && match[2] === filename) return match[1]!.toLowerCase();
  }
  return null;
}

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'verifying'
  | 'staged'
  | 'restarting'
  | 'finalizing'
  | 'success'
  | 'failed'
  | 'rolled_back';

const BUSY_STATES: UpdateState[] = ['checking', 'downloading', 'verifying', 'staged', 'restarting'];

export function isBusy(state: UpdateState): boolean {
  return BUSY_STATES.includes(state);
}

// ---------------------------------------------------------------------------
// Android release manifest
// ---------------------------------------------------------------------------

/**
 * `app-manifest.json`, published with every release. It describes the two halves of an
 * Android release: the web bundle (which the app can install by itself) and the APK
 * (which only Android's package installer can install, with the user's consent).
 */
export type AndroidReleaseManifest = {
  version: string;
  /** Bundle the running app can download, verify and swap in on its own. */
  webBundle: { name: string; sha256: string; sizeBytes: number };
  /** Full installer, needed only when the native shell itself changed. */
  apk: { name: string; sha256: string; sizeBytes: number } | null;
  /**
   * Lowest native shell version that can run this web bundle. If the device's shell is
   * older, the web bundle alone is not enough and the APK must be installed.
   */
  minNativeVersion: number;
  notes: string;
};

export function parseAndroidManifest(json: unknown): AndroidReleaseManifest | null {
  if (!json || typeof json !== 'object') return null;
  const raw = json as Record<string, unknown>;
  const bundle = raw.webBundle as Record<string, unknown> | undefined;
  if (typeof raw.version !== 'string' || !bundle) return null;
  if (typeof bundle.name !== 'string' || !/^[a-f0-9]{64}$/i.test(String(bundle.sha256))) return null;
  const apk = raw.apk as Record<string, unknown> | undefined;
  return {
    version: raw.version.trim(),
    webBundle: {
      name: bundle.name,
      sha256: String(bundle.sha256).toLowerCase(),
      sizeBytes: Number(bundle.sizeBytes ?? 0),
    },
    apk:
      apk && typeof apk.name === 'string'
        ? {
            name: apk.name,
            sha256: String(apk.sha256 ?? '').toLowerCase(),
            sizeBytes: Number(apk.sizeBytes ?? 0),
          }
        : null,
    minNativeVersion: Number(raw.minNativeVersion ?? 1),
    notes: typeof raw.notes === 'string' ? raw.notes : '',
  };
}

/**
 * Which half of a release this device can apply.
 * - 'bundle': the app can update itself silently on tap.
 * - 'apk':    the native shell is too old; Android requires installing the APK.
 */
export function updateKindFor(
  manifest: AndroidReleaseManifest,
  installedNativeVersion: number,
): 'bundle' | 'apk' {
  return manifest.minNativeVersion > installedNativeVersion ? 'apk' : 'bundle';
}
