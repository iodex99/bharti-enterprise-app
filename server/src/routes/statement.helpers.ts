import { isValidBusinessDate } from '@shared';
import type { Statement } from '../services/statements.service';

/** ?from=YYYY-MM-DD&to=YYYY-MM-DD → a statement period; anything invalid is ignored. */
export function periodOf(query: Record<string, unknown>): {
  from: string | null;
  to: string | null;
} {
  const pick = (v: unknown) => (typeof v === 'string' && isValidBusinessDate(v) ? v : null);
  return { from: pick(query.from), to: pick(query.to) };
}

/** "Statement-Meena-2026-11.pdf" — safe for a Content-Disposition header and WhatsApp. */
export function statementFileName(st: Statement): string {
  const name = st.party.name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'statement';
  const stamp = st.period.to ?? st.period.from ?? new Date().toISOString().slice(0, 10);
  return `Statement-${name}-${stamp}.pdf`;
}
