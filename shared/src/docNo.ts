/** Document number prefixes, one per document family. */
export const DOC_PREFIXES = {
  purchase: 'RM',
  cutting: 'CUT',
  job: 'JOB',
  receipt: 'RCT',
  check: 'CHK',
  pack: 'PCK',
  dispatch: 'DSP',
  opening: 'OPB',
  payment: 'PAY',
  staff_payment: 'SPAY',
} as const;

export type DocFamily = keyof typeof DOC_PREFIXES;

/**
 * formatDocNo('job', 7) -> "JOB-0007"; grows past 4 digits naturally.
 * Every doc_no column is UNIQUE across the whole database, so documents from an office
 * other than the first carry that office's code: formatDocNo('job', 7, 'BR') ->
 * "BR-JOB-0007". The first office keeps the plain series (ADR-028).
 */
export function formatDocNo(family: DocFamily, n: number, officeCode?: string): string {
  const base = `${DOC_PREFIXES[family]}-${String(n).padStart(4, '0')}`;
  return officeCode ? `${officeCode}-${base}` : base;
}
