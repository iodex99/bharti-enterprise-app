import { describe, expect, it } from 'vitest';
import nodeCrypto from 'node:crypto';
import nodePath from 'node:path';
import { createHash, randomBytes, sha256Hex } from '../../../client/src/local/shims/node-crypto';
import * as shimPath from '../../../client/src/local/shims/node-path';

/**
 * The Android runtime replaces a few Node builtins with hand-written implementations.
 * They are covered here, against the real Node modules, because a subtle difference
 * would be invisible until it corrupted a session token or a stored file path.
 */

describe('node:crypto shim', () => {
  const samples = [
    '',
    'a',
    'abc',
    'bharti-enterprises',
    'x'.repeat(55), // one byte under a block boundary
    'y'.repeat(56), // forces an extra padding block
    'z'.repeat(64),
    'z'.repeat(200),
    '🧵 scrunchie ✂️ unicode',
  ];

  it('produces the same SHA-256 as Node for every shape of input', () => {
    for (const sample of samples) {
      const expected = nodeCrypto.createHash('sha256').update(sample).digest('hex');
      expect(createHash('sha256').update(sample).digest('hex')).toBe(expected);
      expect(sha256Hex(new TextEncoder().encode(sample))).toBe(expected);
    }
  });

  it('hashes chunked updates identically to one update', () => {
    const whole = createHash('sha256').update('abcdefghij').digest('hex');
    const chunked = createHash('sha256').update('abcde').update('fghij').digest('hex');
    expect(chunked).toBe(whole);
    expect(whole).toBe(nodeCrypto.createHash('sha256').update('abcdefghij').digest('hex'));
  });

  it('matches Node for base64 digests too', () => {
    expect(createHash('sha256').update('abc').digest('base64')).toBe(
      nodeCrypto.createHash('sha256').update('abc').digest('base64'),
    );
  });

  it('refuses algorithms it cannot actually compute', () => {
    expect(() => createHash('md5')).toThrow(/Unsupported hash algorithm/);
  });

  it('returns random hex of the requested length', () => {
    const token = randomBytes(32).toString('hex');
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(randomBytes(32).toString('hex')).not.toBe(token);
  });
});

describe('node:path shim', () => {
  const cases: Array<[string, string[]]> = [
    ['join', ['/data', 'uploads', '2026-07']],
    ['join', ['/data/', '/uploads/']],
    ['join', ['a', 'b', '..', 'c']],
    ['join', ['/data', '.', 'x.db']],
    ['resolve', ['/data', 'backups']],
    ['resolve', ['/data', '/absolute']],
    ['dirname', ['/data/uploads/x.webp']],
    ['dirname', ['/x']],
    ['basename', ['/data/uploads/x.webp']],
    ['extname', ['/data/uploads/x.webp']],
    ['extname', ['/data/noext']],
    ['normalize', ['/data//uploads/../x']],
  ];

  it('agrees with node:path (posix) on the operations the server performs', () => {
    for (const [fn, args] of cases) {
      const expected = (nodePath.posix as unknown as Record<string, (...a: string[]) => string>)[fn]!(
        ...args,
      );
      const actual = (shimPath as unknown as Record<string, (...a: string[]) => string>)[fn]!(
        ...args,
      );
      expect(`${fn}(${args.join(', ')}) = ${actual}`).toBe(`${fn}(${args.join(', ')}) = ${expected}`);
    }
  });

  it('strips a known extension from basename like node does', () => {
    expect(shimPath.basename('/a/b/token.zip', '.zip')).toBe('token');
    expect(shimPath.basename('/a/b/token.zip', '.zip')).toBe(
      nodePath.posix.basename('/a/b/token.zip', '.zip'),
    );
  });
});
