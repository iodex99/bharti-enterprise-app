import { GENESIS_REF_TYPES, TERMINAL_REF_TYPES } from '@shared';
import type { Db } from '../db/connection';

/**
 * Self-reconciliation: re-derives the ledger's conservation laws on demand so drift
 * (a bug, manual DB edit, or partial write) is caught the moment it exists — visible
 * on the admin System Health panel.
 */

export type ReconciliationCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

export function runReconciliation(db: Db): { ok: boolean; checks: ReconciliationCheck[] } {
  const checks: ReconciliationCheck[] = [];
  const genesisList = GENESIS_REF_TYPES.map((t) => `'${t}'`).join(',');
  const terminalList = TERMINAL_REF_TYPES.map((t) => `'${t}'`).join(',');

  // 1. No lot may be negative.
  const negativeLots = db
    .prepare(
      `SELECT stage, lot_type, lot_id, SUM(qty) AS bal FROM stock_ledger
       GROUP BY stage, lot_type, lot_id HAVING SUM(qty) < 0`,
    )
    .all() as Array<{ stage: string; lot_type: string; lot_id: number; bal: number }>;
  checks.push({
    name: 'No negative stock lots',
    ok: negativeLots.length === 0,
    detail:
      negativeLots.length === 0
        ? 'Every lot balance is zero or positive.'
        : `${negativeLots.length} lot(s) below zero, e.g. ${negativeLots[0]!.stage} ${negativeLots[0]!.lot_type} #${negativeLots[0]!.lot_id} = ${negativeLots[0]!.bal}.`,
  });

  // 2. Piece conservation: created − destroyed = on hand (non-RAW stages).
  const pieceRow = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN ref_type IN (${genesisList}) THEN qty END), 0) AS genesis,
         COALESCE(SUM(CASE WHEN ref_type IN (${terminalList}) THEN -qty END), 0) AS terminal,
         COALESCE(SUM(qty), 0) AS onHand
       FROM stock_ledger WHERE stage != 'RAW'`,
    )
    .get() as { genesis: number; terminal: number; onHand: number };
  const pieceDrift = pieceRow.genesis - pieceRow.terminal - pieceRow.onHand;
  checks.push({
    name: 'Piece conservation (all stages after cutting)',
    ok: pieceDrift === 0,
    detail:
      pieceDrift === 0
        ? `${pieceRow.genesis} pcs created − ${pieceRow.terminal} pcs lost/dispatched = ${pieceRow.onHand} pcs on hand.`
        : `DRIFT of ${pieceDrift} pcs: created ${pieceRow.genesis}, removed ${pieceRow.terminal}, on hand ${pieceRow.onHand}.`,
  });

  // 3. RAW conservation (cm).
  const rawRow = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN ref_type IN (${genesisList}) THEN qty END), 0) AS genesis,
         COALESCE(SUM(CASE WHEN ref_type IN (${terminalList}) THEN -qty END), 0) AS terminal,
         COALESCE(SUM(qty), 0) AS onHand
       FROM stock_ledger WHERE stage = 'RAW'`,
    )
    .get() as { genesis: number; terminal: number; onHand: number };
  const rawDrift = rawRow.genesis - rawRow.terminal - rawRow.onHand;
  checks.push({
    name: 'Raw cloth conservation (meters)',
    ok: rawDrift === 0,
    detail:
      rawDrift === 0
        ? `${(rawRow.genesis / 100).toFixed(2)} m in − ${(rawRow.terminal / 100).toFixed(2)} m used = ${(rawRow.onHand / 100).toFixed(2)} m on hand.`
        : `DRIFT of ${(rawDrift / 100).toFixed(2)} m.`,
  });

  // 4. Transfer ref types must net to zero per reference.
  const unbalanced = db
    .prepare(
      `SELECT ref_type, ref_id, SUM(qty) AS net FROM stock_ledger
       WHERE ref_type NOT IN (${genesisList}) AND ref_type NOT IN (${terminalList})
       GROUP BY ref_type, ref_id HAVING SUM(qty) != 0`,
    )
    .all() as Array<{ ref_type: string; ref_id: number; net: number }>;
  checks.push({
    name: 'Every transfer is balanced',
    ok: unbalanced.length === 0,
    detail:
      unbalanced.length === 0
        ? 'All stage-to-stage movements net to zero.'
        : `${unbalanced.length} unbalanced transfer(s), e.g. ${unbalanced[0]!.ref_type} #${unbalanced[0]!.ref_id} nets ${unbalanced[0]!.net}.`,
  });

  // 5. Job WIP matches document math (issued − received − returned − written off).
  const wipMismatch = db
    .prepare(
      `SELECT l.id FROM job_card_lines l
       JOIN job_cards j ON j.id = l.job_card_id AND j.voided_at IS NULL
       JOIN v_job_line_status v ON v.job_card_line_id = l.id
       WHERE (SELECT COALESCE(SUM(s.qty),0) FROM stock_ledger s
              WHERE s.stage='WIP' AND s.lot_type='job_line' AND s.lot_id = l.id)
             NOT IN (
               MAX(0, l.qty_issued_pcs - v.received_pcs - v.returned_pcs -
                 COALESCE((SELECT SUM(-s2.qty) FROM stock_ledger s2
                   WHERE s2.ref_type='job_shortage' AND s2.lot_type='job_line' AND s2.lot_id=l.id), 0)),
               0
             )`,
    )
    .all() as Array<{ id: number }>;
  checks.push({
    name: 'Contractor WIP matches job documents',
    ok: wipMismatch.length === 0,
    detail:
      wipMismatch.length === 0
        ? 'Ledger WIP equals issued − received − returned − written-off on every job line.'
        : `${wipMismatch.length} job line(s) disagree with the ledger.`,
  });

  return { ok: checks.every((c) => c.ok), checks };
}
