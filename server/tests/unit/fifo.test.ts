import { describe, expect, it } from 'vitest';
import { splitFifo, type LotType } from '../../src/services/ledger.service';

const lot = (lotId: number, qty: number) => ({ lotType: 'cutting_line' as LotType, lotId, qty });

describe('splitFifo', () => {
  it('takes from the oldest lot first (exact fit)', () => {
    expect(splitFifo([lot(1, 50), lot(2, 30)], 50)).toEqual([lot(1, 50)]);
  });

  it('spans lots in order', () => {
    expect(splitFifo([lot(1, 50), lot(2, 30), lot(3, 100)], 90)).toEqual([
      lot(1, 50),
      lot(2, 30),
      lot(3, 10),
    ]);
  });

  it('takes a partial from a single lot', () => {
    expect(splitFifo([lot(7, 120)], 30)).toEqual([lot(7, 30)]);
  });

  it('throws when the pool is insufficient', () => {
    expect(() => splitFifo([lot(1, 10), lot(2, 5)], 16)).toThrow(/Not enough stock/);
  });

  it('rejects zero/negative/fractional requirements', () => {
    expect(() => splitFifo([lot(1, 10)], 0)).toThrow(/positive integer/);
    expect(() => splitFifo([lot(1, 10)], -5)).toThrow(/positive integer/);
    expect(() => splitFifo([lot(1, 10)], 2.5)).toThrow(/positive integer/);
  });

  it('skips exhausted lots gracefully', () => {
    expect(splitFifo([lot(1, 0), lot(2, 10)], 10)).toEqual([lot(2, 10)]);
  });
});
