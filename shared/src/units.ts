/**
 * Unit handling rules (see docs/ARCHITECTURE.md):
 * - Stitched-stage quantities are stored as integer PIECES (1 dozen = 12 pieces).
 * - Raw cloth is stored as integer CENTIMETERS.
 * - Money is stored as integer PAISE.
 * Floats never enter the database; these helpers are the only conversion path.
 */

export const PIECES_PER_DOZEN = 12;
export const CM_PER_METER = 100;

const EPSILON = 1e-6;

function assertInteger(value: number, label: string): void {
  if (!Number.isFinite(value) || Math.abs(value - Math.round(value)) > EPSILON) {
    throw new Error(`${label} must resolve to a whole number, got ${value}`);
  }
}

/** Convert a dozens + pieces entry ("2 dz 6 pc") to total pieces. */
export function dzPcToPieces(dozens: number, pieces = 0): number {
  const total = dozens * PIECES_PER_DOZEN + pieces;
  assertInteger(total, 'quantity in pieces');
  return Math.round(total);
}

/** Convert decimal dozens (e.g. 2.5) to pieces, rejecting values that are not whole pieces. */
export function dozensToPieces(dozens: number): number {
  const pcs = dozens * PIECES_PER_DOZEN;
  assertInteger(pcs, 'quantity in pieces');
  return Math.round(pcs);
}

export function piecesToDozens(pieces: number): number {
  return pieces / PIECES_PER_DOZEN;
}

/** Split total pieces into { dz, pc } where 0 <= pc < 12 (sign carried on dz side for display). */
export function piecesToDzPc(totalPieces: number): { dz: number; pc: number } {
  assertInteger(totalPieces, 'pieces');
  const abs = Math.abs(Math.round(totalPieces));
  const dz = Math.floor(abs / PIECES_PER_DOZEN);
  const pc = abs % PIECES_PER_DOZEN;
  return totalPieces < 0 ? { dz: -dz, pc: pc === 0 ? 0 : -pc } : { dz, pc };
}

/** Format pieces for display: 30 -> "2dz 6pc", 24 -> "2dz", 5 -> "5pc", 0 -> "0". */
export function formatPieces(totalPieces: number): string {
  assertInteger(totalPieces, 'pieces');
  const rounded = Math.round(totalPieces);
  if (rounded === 0) return '0';
  const sign = rounded < 0 ? '-' : '';
  const abs = Math.abs(rounded);
  const dz = Math.floor(abs / PIECES_PER_DOZEN);
  const pc = abs % PIECES_PER_DOZEN;
  if (dz === 0) return `${sign}${pc}pc`;
  if (pc === 0) return `${sign}${dz}dz`;
  return `${sign}${dz}dz ${pc}pc`;
}

/** Meters (possibly decimal, max 2dp) to integer centimeters. */
export function metersToCm(meters: number): number {
  const cm = meters * CM_PER_METER;
  assertInteger(cm, 'length in cm');
  return Math.round(cm);
}

export function cmToMeters(cm: number): number {
  return cm / CM_PER_METER;
}

/** Format centimeters as meters for display: 12550 -> "125.5 m". */
export function formatCm(cm: number): string {
  const meters = cm / CM_PER_METER;
  const str = Number.isInteger(meters) ? meters.toString() : meters.toFixed(2).replace(/0$/, '');
  return `${str} m`;
}

/** Rupees (possibly decimal, max 2dp) to integer paise. */
export function rupeesToPaise(rupees: number): number {
  const paise = rupees * 100;
  assertInteger(paise, 'amount in paise');
  return Math.round(paise);
}

export function paiseToRupees(paise: number): number {
  return paise / 100;
}

const inrFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
});

/** Format paise as Indian rupees: 123450 -> "₹1,234.50". */
export function formatPaise(paise: number): string {
  return inrFormatter.format(paise / 100);
}

/** Percentage with one decimal, e.g. variancePct(120, 108) -> -10. */
export function variancePct(expected: number, actual: number): number {
  if (expected === 0) return actual === 0 ? 0 : 100;
  return Math.round(((actual - expected) / expected) * 1000) / 10;
}
