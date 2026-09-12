import { describe, expect, it } from 'vitest';
import {
  expectedHashFor,
  isBusy,
  parseReleaseResponse,
} from '../../src/services/update.helpers';

describe('parseReleaseResponse', () => {
  const release = {
    tag_name: 'v1.0.42',
    body: 'notes here',
    published_at: '2026-07-10T00:00:00Z',
    assets: [
      {
        name: 'bharti-app-v1.0.42.zip',
        browser_download_url: 'https://x/zip',
        url: 'https://api/assets/1',
      },
      { name: 'checksums.txt', browser_download_url: 'https://x/sums', url: 'https://api/assets/2' },
    ],
  };

  it('parses a GitHub releases/latest payload', () => {
    const parsed = parseReleaseResponse(release);
    expect(parsed).toEqual({
      version: 'v1.0.42',
      zipName: 'bharti-app-v1.0.42.zip',
      zipUrl: 'https://x/zip',
      zipApiUrl: 'https://api/assets/1',
      checksumsUrl: 'https://x/sums',
      checksumsApiUrl: 'https://api/assets/2',
      notes: 'notes here',
      publishedAt: '2026-07-10T00:00:00Z',
    });
  });

  it('tolerates missing checksums asset and API urls (mock feed)', () => {
    const parsed = parseReleaseResponse({
      ...release,
      assets: [{ name: 'a.zip', browser_download_url: 'https://x/a.zip' }],
    });
    expect(parsed?.checksumsUrl).toBeNull();
    expect(parsed?.zipApiUrl).toBeNull();
  });

  it('rejects payloads without a zip asset', () => {
    expect(parseReleaseResponse({ ...release, assets: [release.assets[1]] })).toBeNull();
  });

  it('rejects garbage', () => {
    expect(parseReleaseResponse(null)).toBeNull();
    expect(parseReleaseResponse('x')).toBeNull();
    expect(parseReleaseResponse({})).toBeNull();
  });
});

describe('expectedHashFor', () => {
  const sums = [
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  one.zip',
    'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB  two.zip',
    'not-a-hash-line',
  ].join('\n');

  it('finds the hash for a filename', () => {
    expect(expectedHashFor(sums, 'one.zip')).toBe('a'.repeat(64));
  });

  it('lowercases hashes', () => {
    expect(expectedHashFor(sums, 'two.zip')).toBe('b'.repeat(64));
  });

  it('returns null when absent', () => {
    expect(expectedHashFor(sums, 'three.zip')).toBeNull();
    expect(expectedHashFor('', 'one.zip')).toBeNull();
  });

  it('handles CRLF and BSD-style asterisk', () => {
    const crlf = `${'c'.repeat(64)}  *file.zip\r\n`;
    expect(expectedHashFor(crlf, 'file.zip')).toBe('c'.repeat(64));
  });
});

describe('isBusy', () => {
  it('classifies states', () => {
    expect(isBusy('idle')).toBe(false);
    expect(isBusy('downloading')).toBe(true);
    expect(isBusy('staged')).toBe(true);
    expect(isBusy('success')).toBe(false);
    expect(isBusy('rolled_back')).toBe(false);
  });
});

/**
 * The PC line (1.0.x) and the dormant Android line (1.1.x) publish to ONE public
 * releases repo, so a release can carry both platforms' zips. Picking the wrong one
 * would have the office server install an Android web bundle — it would fail the
 * staging check, but only after downloading and wiping a release directory.
 */
describe('choosing our own asset from a shared releases feed', () => {
  const mixed = {
    tag_name: 'v1.0.42',
    body: '',
    published_at: null,
    assets: [
      // Android's asset sorts FIRST — the old "first .zip wins" rule picked this.
      { name: 'web-bundle-v1.1.7.zip', browser_download_url: 'https://x/bundle', url: 'https://api/1' },
      { name: 'bharti-app-v1.0.42.zip', browser_download_url: 'https://x/pc', url: 'https://api/2' },
      { name: 'checksums.txt', browser_download_url: 'https://x/sums', url: 'https://api/3' },
    ],
  };

  const PC_ZIP = /^bharti-app-v.*\.zip$/i;

  it('takes the PC zip, not whichever zip comes first', () => {
    const parsed = parseReleaseResponse(mixed, { zipMatch: PC_ZIP });
    expect(parsed?.zipName).toBe('bharti-app-v1.0.42.zip');
    expect(parsed?.zipUrl).toBe('https://x/pc');
  });

  it('reports no release rather than installing a foreign asset', () => {
    const androidOnly = { ...mixed, assets: [mixed.assets[0]!, mixed.assets[2]!] };
    expect(parseReleaseResponse(androidOnly, { zipMatch: PC_ZIP })).toBeNull();
  });

  it('without a matcher keeps the historic first-zip behaviour (mock feed)', () => {
    expect(parseReleaseResponse(mixed)?.zipName).toBe('web-bundle-v1.1.7.zip');
  });
});
