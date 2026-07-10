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
} as const;

export type DocFamily = keyof typeof DOC_PREFIXES;

/** formatDocNo('job', 7) -> "JOB-0007"; grows past 4 digits naturally. */
export function formatDocNo(family: DocFamily, n: number): string {
  return `${DOC_PREFIXES[family]}-${String(n).padStart(4, '0')}`;
}
