import { describe, expect, it } from 'vitest';
import {
  clothRequiredInchC,
  dozensToPieces,
  dzPcToPieces,
  formatInchC,
  formatLen,
  formatPaise,
  formatPieces,
  inchCToInches,
  inchCToYards,
  inchesToInchC,
  paiseToRupees,
  piecesToDzPc,
  rupeesToPaise,
  suggestedWidthCount,
  variancePct,
  yardsToInchC,
} from '@shared';

describe('pieces/dozens', () => {
  it('converts dz+pc entry to pieces', () => {
    expect(dzPcToPieces(2, 6)).toBe(30);
    expect(dzPcToPieces(0, 5)).toBe(5);
    expect(dzPcToPieces(10)).toBe(120);
  });

  it('converts decimal dozens when they are whole pieces', () => {
    expect(dozensToPieces(2.5)).toBe(30);
    expect(dozensToPieces(0.25)).toBe(3);
    expect(dozensToPieces(1 / 3)).toBe(4);
  });

  it('rejects dozens that are not whole pieces', () => {
    expect(() => dozensToPieces(0.1)).toThrow(/whole number/);
    expect(() => dozensToPieces(2.7)).toThrow(/whole number/);
  });

  it('rejects non-finite values', () => {
    expect(() => dozensToPieces(Number.NaN)).toThrow(/whole number/);
    expect(() => dozensToPieces(Number.POSITIVE_INFINITY)).toThrow(/whole number/);
  });

  it('splits pieces into dz/pc', () => {
    expect(piecesToDzPc(30)).toEqual({ dz: 2, pc: 6 });
    expect(piecesToDzPc(24)).toEqual({ dz: 2, pc: 0 });
    expect(piecesToDzPc(0)).toEqual({ dz: 0, pc: 0 });
    expect(piecesToDzPc(-30)).toEqual({ dz: -2, pc: -6 });
  });

  it('formats pieces', () => {
    expect(formatPieces(30)).toBe('2dz 6pc');
    expect(formatPieces(24)).toBe('2dz');
    expect(formatPieces(5)).toBe('5pc');
    expect(formatPieces(0)).toBe('0');
    expect(formatPieces(-30)).toBe('-2dz 6pc');
    expect(formatPieces(-5)).toBe('-5pc');
  });
});

describe('yards / hundredths of an inch', () => {
  it('converts yards to inch_c exactly (2dp yards always fit integers)', () => {
    expect(yardsToInchC(125.5)).toBe(451800);
    expect(yardsToInchC(0.01)).toBe(36); // one hundredth of a yard = 0.36" = 36 inch_c
    expect(yardsToInchC(1)).toBe(3600);
    expect(yardsToInchC(1.25)).toBe(4500);
  });

  it('rejects lengths finer than the unit can hold', () => {
    expect(() => yardsToInchC(0.001)).toThrow(/whole number/);
  });

  it('round-trips', () => {
    expect(inchCToYards(yardsToInchC(37.25))).toBe(37.25);
  });

  it('formats inch_c as yards', () => {
    expect(formatLen(451800)).toBe('125.5 yd');
    expect(formatLen(3600)).toBe('1 yd');
    expect(formatLen(4500)).toBe('1.25 yd');
  });
});

describe('money', () => {
  it('converts rupees to paise', () => {
    expect(rupeesToPaise(1234.5)).toBe(123450);
    expect(rupeesToPaise(0.01)).toBe(1);
  });

  it('rejects sub-paise amounts', () => {
    expect(() => rupeesToPaise(0.001)).toThrow(/whole number/);
  });

  it('handles float-imprecise rupee values', () => {
    // 19.99 * 100 = 1998.9999999999998 in IEEE 754 — must still round cleanly
    expect(rupeesToPaise(19.99)).toBe(1999);
    expect(rupeesToPaise(0.29)).toBe(29);
  });

  it('round-trips', () => {
    expect(paiseToRupees(rupeesToPaise(99.95))).toBe(99.95);
  });

  it('formats paise as INR', () => {
    expect(formatPaise(123450)).toBe('₹1,234.50');
    expect(formatPaise(100)).toBe('₹1.00');
    expect(formatPaise(1000000000)).toBe('₹1,00,00,000.00'); // Indian grouping
  });
});

describe('variance', () => {
  it('computes signed percentage', () => {
    expect(variancePct(120, 108)).toBe(-10);
    expect(variancePct(120, 132)).toBe(10);
    expect(variancePct(120, 120)).toBe(0);
  });

  it('handles zero expected', () => {
    expect(variancePct(0, 0)).toBe(0);
    expect(variancePct(0, 12)).toBe(100);
  });

  it('rounds to one decimal', () => {
    expect(variancePct(36, 35)).toBe(-2.8);
  });
});

describe('cutting geometry (inches + width count)', () => {
  it('converts inches to hundredths and back, rejecting sub-hundredth precision', () => {
    expect(inchesToInchC(10)).toBe(1000);
    expect(inchesToInchC(10.25)).toBe(1025);
    expect(inchCToInches(1025)).toBe(10.25);
    expect(() => inchesToInchC(10.255)).toThrow(/whole number/);
  });

  it('formats hundredths of an inch', () => {
    expect(formatInchC(1000)).toBe('10"');
    expect(formatInchC(1025)).toBe('10.25"');
    expect(formatInchC(1050)).toBe('10.5"');
  });

  it('computes cloth consumption: strips of the width, pure integers, no rounding loss', () => {
    // 120 pcs, 10" each, 3 across → 40 strips × 1000 = 40000 inch_c (≈11.11 yd)
    expect(clothRequiredInchC(120, 1000, 3)).toBe(40000);
    // partial strip still consumes a full strip: 121 pcs → 41 strips
    expect(clothRequiredInchC(121, 1000, 3)).toBe(41000);
    // width 1 = every piece is its own strip
    expect(clothRequiredInchC(10, 1200, 1)).toBe(12000);
    // 180 pcs, 9" × 3 across → 60 strips × 900 = 54000 (exactly 15 yd — integers all the way)
    expect(clothRequiredInchC(180, 900, 3)).toBe(54000);
  });

  it('returns 0 for empty/invalid rather than negative or NaN', () => {
    expect(clothRequiredInchC(0, 1000, 3)).toBe(0);
    expect(clothRequiredInchC(10, 0, 3)).toBe(0);
    expect(clothRequiredInchC(10, 1000, 0)).toBe(0);
  });

  it('suggests how many pieces fit across the cloth width', () => {
    expect(suggestedWidthCount(4400, 1000)).toBe(4); // 44" cloth, 10" pieces
    expect(suggestedWidthCount(4400, 800)).toBe(5);
    expect(suggestedWidthCount(0, 800)).toBe(0);
  });
});
