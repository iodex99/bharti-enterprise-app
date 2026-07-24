/**
 * Unit handling rules (see docs/ARCHITECTURE.md):
 * - Stitched-stage quantities are stored as integer PIECES (1 dozen = 12 pieces).
 * - Cloth length AND width are stored as integer HUNDREDTHS OF AN INCH ("inch_c").
 *   The business buys and measures cloth in YARDS (1 yard = 36 inches), so 1.25 yd
 *   = 4500 inch_c exactly — yards with two decimals always fit integers.
 * - Money is stored as integer PAISE.
 * Floats never enter the database; these helpers are the only conversion path.
 */

export const PIECES_PER_DOZEN = 12;
export const INCHES_PER_YARD = 36;
/** hundredths of an inch per yard: 36 in × 100 */
export const INCH_C_PER_YARD = INCHES_PER_YARD * 100;

const EPSILON = 1e-6;

function assertInteger(value: number, label: string): void {
  if (!Number.isFinite(value) || Math.abs(value - Math.round(value)) > EPSILON) {
    throw new Error(`${label} must resolve to a whole number, got ${value}`);
  }
}

// ---------------------------------------------------------------------------
// pieces / dozens
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// cloth length & width: yards ↔ hundredths of an inch
// ---------------------------------------------------------------------------

/** Yards (max 2dp, e.g. 125.5) to integer hundredths of an inch. 1.25 yd -> 4500. */
export function yardsToInchC(yards: number): number {
  const c = yards * INCH_C_PER_YARD;
  assertInteger(c, 'length in hundredths of an inch');
  return Math.round(c);
}

export function inchCToYards(inchC: number): number {
  return inchC / INCH_C_PER_YARD;
}

/** Inches (max 2dp, e.g. 10.25 or a 44" width) to integer hundredths of an inch. */
export function inchesToInchC(inches: number): number {
  const c = inches * 100;
  assertInteger(c, 'length in hundredths of an inch');
  return Math.round(c);
}

export function inchCToInches(inchC: number): number {
  return inchC / 100;
}

/** Format a cloth LENGTH for display: 451800 -> "125.5 yd". */
export function formatLen(inchC: number): string {
  const yards = inchC / INCH_C_PER_YARD;
  const str = Number.isInteger(yards) ? yards.toString() : yards.toFixed(2).replace(/0$/, '');
  return `${str} yd`;
}

/** Format a per-piece length or cloth WIDTH: 1025 -> `10.25"`, 4400 -> `44"`. */
export function formatInchC(inchC: number): string {
  const inches = inchC / 100;
  const str = Number.isInteger(inches) ? inches.toString() : inches.toFixed(2).replace(/0$/, '');
  return `${str}"`;
}

// ---------------------------------------------------------------------------
// money
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Cutting geometry — pure integers, no unit crossing.
// A piece takes `clothPerPcInchC` of LENGTH, and `widthCount` pieces are cut side by
// side across the cloth width. The cloth needed is whole strips.
// ---------------------------------------------------------------------------

/**
 * Cloth consumed by one cutting line, in integer hundredths of an inch of length:
 * ceil(pcs / widthCount) strips × length per piece. Rounded UP to whole strips —
 * a started strip is used cloth.
 * e.g. 120 pcs, 10" per piece, 3 across → 40 strips × 1000 = 40000 inch_c (≈11.11 yd).
 */
export function clothRequiredInchC(
  expectedPcs: number,
  clothPerPcInchC: number,
  widthCount: number,
): number {
  assertInteger(expectedPcs, 'pieces');
  assertInteger(clothPerPcInchC, 'hundredths of an inch');
  assertInteger(widthCount, 'width count');
  if (expectedPcs <= 0 || clothPerPcInchC <= 0 || widthCount <= 0) return 0;
  const strips = Math.ceil(expectedPcs / widthCount);
  return strips * clothPerPcInchC;
}

/**
 * How many pieces fit side by side across the cloth, from the cloth's width and the
 * width one piece needs — a SUGGESTION for the cutting form (the cutter can override).
 */
export function suggestedWidthCount(clothWidthInchC: number, pieceWidthInchC: number): number {
  if (clothWidthInchC <= 0 || pieceWidthInchC <= 0) return 0;
  return Math.floor(clothWidthInchC / pieceWidthInchC);
}
