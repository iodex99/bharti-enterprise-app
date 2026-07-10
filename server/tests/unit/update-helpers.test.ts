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
