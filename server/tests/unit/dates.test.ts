import { describe, expect, it } from 'vitest';
import { formatBusinessDate, isValidBusinessDate } from '@shared';

describe('business dates', () => {
  it('validates real dates', () => {
    expect(isValidBusinessDate('2026-07-10')).toBe(true);
    expect(isValidBusinessDate('2026-02-29')).toBe(false); // not a leap year
    expect(isValidBusinessDate('2024-02-29')).toBe(true);
    expect(isValidBusinessDate('2026-13-01')).toBe(false);
    expect(isValidBusinessDate('2026-00-10')).toBe(false);
    expect(isValidBusinessDate('10/07/2026')).toBe(false);
    expect(isValidBusinessDate('')).toBe(false);
  });

  it('formats for display as DD/MM/YYYY', () => {
    expect(formatBusinessDate('2026-07-10')).toBe('10/07/2026');
  });
});
