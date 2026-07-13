import { nowIso, type Db } from '../db/connection';
import { audit } from './audit.service';

/**
 * Discrepancy review workflow. Rows are CREATED by the modules (cutting variance,
 * job excess/shortage, checking missing/rejected, packing short) — this service only
 * lists them with their source-document context and lets an admin mark them resolved.
 * Resolution is an acknowledgement (who reviewed it + outcome note), NEVER a stock
 * movement: the ledger effect already happened when the discrepancy was recorded.
 */

export type DiscrepancyRow = {
  id: number;
  createdAt: string;
  stage: string;
  docNo: string | null;
  party: string; // contractor / checker / packer ('' for cutting)
  item: string | null; // "MODEL Color SIZE"
  qtyPcs: number; // signed: negative = fewer/lost, positive = extra
  reason: string;
  note: string;
  resolvedAt: string | null;
  resolvedByName: string | null;
  resolutionNote: string;
};

export function listDiscrepancies(db: Db): DiscrepancyRow[] {
  const rows = db
    .prepare(
      `SELECT d.id, d.created_at AS createdAt, d.stage, d.qty_pcs AS qtyPcs, d.reason, d.note,
              d.resolved_at AS resolvedAt, d.resolution_note AS resolutionNote,
              ru.display_name AS resolvedByName,
              CASE d.ref_type
                WHEN 'cutting_line'  THEN cb.doc_no
                WHEN 'job_card_line' THEN jc.doc_no
                WHEN 'check_result'  THEN ci.doc_no
                WHEN 'pack_result'   THEN pi.doc_no
              END AS docNo,
              COALESCE(CASE d.ref_type
                WHEN 'job_card_line' THEN ct.name
                WHEN 'check_result'  THEN cst.name
                WHEN 'pack_result'   THEN pst.name
              END, '') AS party,
              CASE d.ref_type
                WHEN 'cutting_line'  THEN m_cb.code || ' ' || c_cb.name || ' ' || s_cl.code
                WHEN 'job_card_line' THEN m_jc.code || ' ' || c_jc.name || ' ' || s_jl.code
                WHEN 'check_result'  THEN m_ci.code || ' ' || c_ci.name || ' ' || s_ci.code
                WHEN 'pack_result'   THEN m_pi.code || ' ' || c_pi.name || ' ' || s_pi.code
              END AS item
       FROM discrepancies d
       LEFT JOIN users ru ON ru.id = d.resolved_by
       LEFT JOIN cutting_lines cl   ON d.ref_type = 'cutting_line' AND cl.id = d.ref_id
       LEFT JOIN cutting_batches cb ON cb.id = cl.cutting_batch_id
       LEFT JOIN models m_cb ON m_cb.id = cb.model_id
       LEFT JOIN colors c_cb ON c_cb.id = cb.color_id
       LEFT JOIN sizes  s_cl ON s_cl.id = cl.size_id
       LEFT JOIN job_card_lines jl ON d.ref_type = 'job_card_line' AND jl.id = d.ref_id
       LEFT JOIN job_cards jc ON jc.id = jl.job_card_id
       LEFT JOIN contractors ct ON ct.id = jc.contractor_id
       LEFT JOIN models m_jc ON m_jc.id = jc.model_id
       LEFT JOIN colors c_jc ON c_jc.id = jc.color_id
       LEFT JOIN sizes  s_jl ON s_jl.id = jl.size_id
       LEFT JOIN check_results cr ON d.ref_type = 'check_result' AND cr.id = d.ref_id
       LEFT JOIN check_issues ci ON ci.id = cr.check_issue_id
       LEFT JOIN staff cst ON cst.id = ci.staff_id
       LEFT JOIN models m_ci ON m_ci.id = ci.model_id
       LEFT JOIN colors c_ci ON c_ci.id = ci.color_id
       LEFT JOIN sizes  s_ci ON s_ci.id = ci.size_id
       LEFT JOIN pack_results pr ON d.ref_type = 'pack_result' AND pr.id = d.ref_id
       LEFT JOIN pack_issues pi ON pi.id = pr.pack_issue_id
       LEFT JOIN staff pst ON pst.id = pi.staff_id
       LEFT JOIN models m_pi ON m_pi.id = pi.model_id
       LEFT JOIN colors c_pi ON c_pi.id = pi.color_id
       LEFT JOIN sizes  s_pi ON s_pi.id = pi.size_id
       ORDER BY (d.resolved_at IS NOT NULL), d.created_at DESC, d.id DESC`,
    )
    .all() as DiscrepancyRow[];
  return rows;
}

export type ResolveResult = { ok: true } | { ok: false; code: number; error: string };

export function resolveDiscrepancy(
  db: Db,
  id: number,
  note: string,
  userId: number,
  ip: string | null,
): ResolveResult {
  const tx = db.transaction((): ResolveResult => {
    const row = db
      .prepare('SELECT id, stage, reason, resolved_at FROM discrepancies WHERE id = ?')
      .get(id) as { id: number; stage: string; reason: string; resolved_at: string | null } | undefined;
    if (!row) return { ok: false, code: 404, error: 'Discrepancy not found.' };
    if (row.resolved_at) return { ok: false, code: 409, error: 'Already resolved.' };
    db.prepare(
      'UPDATE discrepancies SET resolved_at = ?, resolved_by = ?, resolution_note = ? WHERE id = ?',
    ).run(nowIso(), userId, note, id);
    audit(db, {
      userId,
      action: 'discrepancy_resolve',
      entityType: 'discrepancy',
      entityId: id,
      old: { stage: row.stage, reason: row.reason },
      new: { resolutionNote: note },
      ip,
    });
    return { ok: true };
  });
  return tx();
}
