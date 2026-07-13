/**
 * Date rules: timestamps are UTC ISO strings (audit truth); business dates are
 * plain 'YYYY-MM-DD' strings chosen by the user (backdating allowed).
 * Display is DD/MM/YYYY (Indian convention).
 */

export const BUSINESS_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidBusinessDate(s: string): boolean {
  if (!BUSINESS_DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** '2026-07-10' -> '10/07/2026' */
export function formatBusinessDate(s: string): string {
  if (!BUSINESS_DATE_RE.test(s)) return s;
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

/** Current business date in IST (the factory's timezone), as 'YYYY-MM-DD'. */
export function todayIST(): string {
  return istDateOf(new Date().toISOString());
}

/** UTC ISO timestamp -> the 'YYYY-MM-DD' date it falls on in IST. */
export function istDateOf(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso.slice(0, 10);
  const ist = new Date(t.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

/** UTC ISO timestamp -> 'DD/MM/YYYY, hh:mm am/pm' in IST for display. */
export function formatTimestampIST(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}
