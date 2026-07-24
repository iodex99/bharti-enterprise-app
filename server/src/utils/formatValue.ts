import { formatBusinessDate, formatLen, formatPaise, formatPieces } from '@shared';
import type { ColumnType } from '../services/reports.service';

/** Human formatting for report cells — mirror of the client table renderer. */
export function formatValue(type: ColumnType, value: unknown): string {
  if (value == null || value === '') return '—';
  switch (type) {
    case 'pcs':
      return formatPieces(Number(value));
    case 'len':
      return formatLen(Number(value));
    case 'paise':
      return formatPaise(Number(value));
    case 'pct':
      return `${value}%`;
    case 'date':
      return formatBusinessDate(String(value));
    default:
      return String(value);
  }
}

export const NUMERIC_TYPES = new Set<ColumnType>(['pcs', 'len', 'paise', 'pct', 'int']);
