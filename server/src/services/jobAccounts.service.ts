import type { Db } from '../db/connection';

/**
 * THE contractor money rule, in one place (ADR-046). Every screen that shows what a
 * contractor earned — job card, dues, analytics, dashboard, statement, PDF — reads it
 * from here, so they can never disagree.
 *
 *   payable pcs = stitched received − sent back for rework − reported missing
 *   amount      = payable pcs × line rate ÷ 12, rounded ONCE per job line
 *
 * Rework pieces come back through a normal receipt and are paid then, so a piece is
 * paid exactly once — when it finally passes checking.
 */

export type LineAccount = {
  lineId: number;
  jobCardId: number;
  jobDocNo: string;
  issueDate: string;
  contractorId: number;
  modelCode: string;
  colorName: string;
  sizeCode: string;
  ratePaisePerDozen: number;
  issuedPcs: number;
  stitchedPcs: number;
  unstitchedPcs: number;
  reworkPcs: number;
  missingPcs: number;
  /** written off when the card was closed with a discrepancy */
  shortagePcs: number;
  payablePcs: number;
  amountPaise: number;
};

/** Pieces × rate-per-dozen, in paise, rounded once. */
export function dozenAmount(pcs: number, ratePaisePerDozen: number): number {
  return Math.round((pcs * ratePaisePerDozen) / 12);
}

export function lineAccounts(
  db: Db,
  officeId: number,
  opts: { contractorId?: number; jobCardId?: number } = {},
): LineAccount[] {
  const where = ['j.voided_at IS NULL', 'j.office_id = ?'];
  const params: unknown[] = [officeId];
  if (opts.contractorId) {
    where.push('j.contractor_id = ?');
    params.push(opts.contractorId);
  }
  if (opts.jobCardId) {
    where.push('j.id = ?');
    params.push(opts.jobCardId);
  }
  const rows = db
    .prepare(
      `SELECT l.id AS lineId, j.id AS jobCardId, j.doc_no AS jobDocNo, j.issue_date AS issueDate,
              j.contractor_id AS contractorId, m.code AS modelCode, c.name AS colorName,
              s.code AS sizeCode, l.rate_paise_per_dozen AS ratePaisePerDozen,
              l.qty_issued_pcs AS issuedPcs,
              COALESCE((SELECT SUM(rl.qty_pcs) FROM job_receipt_lines rl
                        JOIN job_receipts r ON r.id = rl.job_receipt_id AND r.voided_at IS NULL
                        WHERE rl.job_card_line_id = l.id AND rl.return_type = 'stitched'), 0) AS stitchedPcs,
              COALESCE((SELECT SUM(rl.qty_pcs) FROM job_receipt_lines rl
                        JOIN job_receipts r ON r.id = rl.job_receipt_id AND r.voided_at IS NULL
                        WHERE rl.job_card_line_id = l.id AND rl.return_type = 'unstitched_return'), 0) AS unstitchedPcs,
              COALESCE((SELECT SUM(a.qty_pcs) FROM contractor_adjustments a
                        WHERE a.job_card_line_id = l.id AND a.kind = 'rework'), 0) AS reworkPcs,
              COALESCE((SELECT SUM(a.qty_pcs) FROM contractor_adjustments a
                        WHERE a.job_card_line_id = l.id AND a.kind = 'missing'), 0) AS missingPcs,
              COALESCE((SELECT SUM(-sl.qty) FROM stock_ledger sl
                        WHERE sl.ref_type = 'job_shortage' AND sl.lot_type = 'job_line' AND sl.lot_id = l.id), 0) AS shortagePcs
       FROM job_card_lines l
       JOIN job_cards j ON j.id = l.job_card_id
       JOIN models m ON m.id = j.model_id
       JOIN colors c ON c.id = j.color_id
       JOIN sizes s ON s.id = l.size_id
       WHERE ${where.join(' AND ')}
       ORDER BY j.issue_date, j.id, s.sort_order, s.code`,
    )
    .all(...params) as Array<Omit<LineAccount, 'payablePcs' | 'amountPaise'>>;
  return rows.map((r) => {
    const payablePcs = Math.max(0, r.stitchedPcs - r.reworkPcs - r.missingPcs);
    return { ...r, payablePcs, amountPaise: dozenAmount(payablePcs, r.ratePaisePerDozen) };
  });
}

/** Total payable for one contractor (or every contractor) in an office. */
export function contractorEarnedPaise(db: Db, officeId: number, contractorId?: number): number {
  return lineAccounts(db, officeId, { contractorId }).reduce((s, l) => s + l.amountPaise, 0);
}

/**
 * Pieces a job line still owes back: issued + sent back for rework − returned so far −
 * written off at close.
 */
export function linePendingPcs(
  l: Pick<LineAccount, 'issuedPcs' | 'reworkPcs' | 'stitchedPcs' | 'unstitchedPcs' | 'shortagePcs'>,
): number {
  return Math.max(0, l.issuedPcs + l.reworkPcs - l.stitchedPcs - l.unstitchedPcs - l.shortagePcs);
}
