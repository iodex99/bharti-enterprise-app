import { describe, expect, it } from 'vitest';
import { compareVersions, isNewerVersion, formatDocNo } from '@shared';

describe('compareVersions', () => {
  it('orders versions numerically, not lexically', () => {
    expect(compareVersions('1.0.9', '1.0.10')).toBeLessThan(0);
    expect(compareVersions('1.0.100', '1.0.99')).toBeGreaterThan(0);
    expect(compareVersions('1.0.42', '1.0.42')).toBe(0);
  });

  it('handles v prefixes', () => {
    expect(compareVersions('v1.0.5', '1.0.4')).toBeGreaterThan(0);
  });

  it('handles dev suffix versions safely', () => {
    expect(isNewerVersion('1.0.1', '0.0.0-dev')).toBe(true);
  });

  it('isNewerVersion is strict', () => {
    expect(isNewerVersion('1.0.5', '1.0.5')).toBe(false);
    expect(isNewerVersion('1.0.4', '1.0.5')).toBe(false);
  });
});

describe('formatDocNo', () => {
  it('pads to four digits', () => {
    expect(formatDocNo('job', 7)).toBe('JOB-0007');
    expect(formatDocNo('purchase', 123)).toBe('RM-0123');
  });

  it('grows beyond 9999', () => {
    expect(formatDocNo('job', 12345)).toBe('JOB-12345');
  });
});
