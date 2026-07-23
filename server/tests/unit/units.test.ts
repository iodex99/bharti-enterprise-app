import { describe, expect, it } from 'vitest';
import {
  clothRequiredCm,
  cmToMeters,
  dozensToPieces,
  dzPcToPieces,
  formatCm,
  formatInchC,
  formatPaise,
  formatPieces,
  inchCToInches,
  inchesToInchC,
  metersToCm,
  paiseToRupees,
  piecesToDzPc,
  rupeesToPaise,
  variancePct,
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

describe('meters/cm', () => {
  it('converts meters to cm', () => {
    expect(metersToCm(125.5)).toBe(12550);
    expect(metersToCm(0.01)).toBe(1);
    expect(metersToCm(1000)).toBe(100000);
  });

  it('rejects sub-centimeter lengths', () => {
    expect(() => metersToCm(0.005)).toThrow(/whole number/);
  });

  it('round-trips', () => {
    expect(cmToMeters(metersToCm(37.25))).toBe(37.25);
  });

  it('formats cm as meters', () => {
    expect(formatCm(12550)).toBe('125.5 m');
    expect(formatCm(100)).toBe('1 m');
    expect(formatCm(12345)).toBe('123.45 m');
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

  it('computes cloth consumption: strips of the width, rounded up', () => {
    // 120 pcs, 10" each, 3 across → 40 strips × 10" = 400" = exactly 1016 cm
    expect(clothRequiredCm(120, 1000, 3)).toBe(1016);
    // partial strip still consumes a full strip: 121 pcs → 41 strips
    expect(clothRequiredCm(121, 1000, 3)).toBe(Math.ceil((41 * 1000 * 254) / 10000));
    // width 1 = every piece is its own strip
    expect(clothRequiredCm(10, 1200, 1)).toBe(Math.ceil((10 * 1200 * 254) / 10000));
    // fractional cm rounds UP (cloth cut is cloth gone): 180 pcs, 9" ×3 → 1371.6 → 1372
    expect(clothRequiredCm(180, 900, 3)).toBe(1372);
  });

  it('returns 0 for empty/invalid rather than negative or NaN', () => {
    expect(clothRequiredCm(0, 1000, 3)).toBe(0);
    expect(clothRequiredCm(10, 0, 3)).toBe(0);
    expect(clothRequiredCm(10, 1000, 0)).toBe(0);
  });
});
