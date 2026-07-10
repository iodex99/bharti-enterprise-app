/** Pure helpers for the update service — unit-tested without network/filesystem. */

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
