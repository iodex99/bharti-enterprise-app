import { describe, expect, it } from 'vitest';
import { parseAndroidManifest, updateKindFor } from '@shared';

/**
 * The release manifest decides whether the app can update itself with one tap or has to
 * ask the user to install a new app file. Both mistakes are bad: refusing a usable
 * bundle strands the device on an old version, and accepting a bundle the native shell
 * cannot run bricks the app until it is reinstalled.
 */

const good = {
  version: '1.0.42',
  webBundle: { name: 'web-bundle-v1.0.42.zip', sha256: 'a'.repeat(64), sizeBytes: 1234 },
  apk: { name: 'bharti-v1.0.42.apk', sha256: 'b'.repeat(64), sizeBytes: 5678 },
  minNativeVersion: 7,
  notes: 'Cutting geometry fixes',
};

describe('android release manifest', () => {
  it('parses a well-formed manifest', () => {
    const manifest = parseAndroidManifest(good);
    expect(manifest).not.toBeNull();
    expect(manifest!.version).toBe('1.0.42');
    expect(manifest!.webBundle.sha256).toBe('a'.repeat(64));
    expect(manifest!.apk?.name).toBe('bharti-v1.0.42.apk');
    expect(manifest!.minNativeVersion).toBe(7);
  });

  it('accepts a bundle-only release (no native change)', () => {
    const manifest = parseAndroidManifest({ ...good, apk: undefined });
    expect(manifest!.apk).toBeNull();
  });

  it('rejects anything without a usable checksum — an unverifiable download is refused', () => {
    expect(parseAndroidManifest(null)).toBeNull();
    expect(parseAndroidManifest('not json')).toBeNull();
    expect(parseAndroidManifest({ ...good, webBundle: undefined })).toBeNull();
    expect(parseAndroidManifest({ ...good, version: 42 })).toBeNull();
    expect(
      parseAndroidManifest({ ...good, webBundle: { ...good.webBundle, sha256: 'short' } }),
    ).toBeNull();
    expect(
      parseAndroidManifest({ ...good, webBundle: { ...good.webBundle, name: 123 } }),
    ).toBeNull();
  });

  it('normalises a mixed-case checksum so comparison is not case-sensitive', () => {
    const manifest = parseAndroidManifest({
      ...good,
      webBundle: { ...good.webBundle, sha256: 'A'.repeat(64) },
    });
    expect(manifest!.webBundle.sha256).toBe('a'.repeat(64));
  });

  it('defaults minNativeVersion to 1 when a release omits it', () => {
    const manifest = parseAndroidManifest({ ...good, minNativeVersion: undefined });
    expect(manifest!.minNativeVersion).toBe(1);
  });
});

describe('choosing between a bundle update and an app-file update', () => {
  const manifest = parseAndroidManifest(good)!;

  it('installs the bundle when the device shell is new enough', () => {
    expect(updateKindFor(manifest, 7)).toBe('bundle');
    expect(updateKindFor(manifest, 99)).toBe('bundle');
  });

  it('requires the app file when the device shell is older than the bundle needs', () => {
    expect(updateKindFor(manifest, 6)).toBe('apk');
    expect(updateKindFor(manifest, 1)).toBe('apk');
  });
});
