import type { PaymentInput } from '@shared';
import type { Db } from '../db/connection';
import { nowIso } from '../db/connection';
import { audit } from './audit.service';
import { nextDocNo } from './docNo.service';
import type { Office } from './offices.service';
import type { ServiceResult } from './purchases.service';

/**
 * Contractor analytics + payments + PENDING DUES (v2, ADR-036), office-scoped.
 * Job-work cost = stitched received qty × line rate / 12; dues = cost − payments.
 */

export function contractorAnalytics(db: Db, officeId: number): Array<Record<string, unknown>> {
  const rows = db
    .prepare(
      `SELECT ct.id, ct.name, ct.mobile, ct.is_active AS isActive,
              ct.default_rate_paise_per_dozen AS defaultRatePaisePerDozen,
              COUNT(DISTINCT j.id) AS totalJobs,
              COUNT(DISTINCT CASE WHEN j.status IN ('open','partially_received') THEN j.id END) AS openJobs,
              COUNT(DISTINCT CASE WHEN j.status = 'closed_with_discrepancy' THEN j.id END) AS discrepancyJobs,
              COALESCE(SUM(l.qty_issued_pcs), 0) AS issuedPcs
       FROM contractors ct
       LEFT JOIN job_cards j ON j.contractor_id = ct.id AND j.voided_at IS NULL AND j.office_id = ?
       LEFT JOIN job_card_lines l ON l.job_card_id = j.id
       WHERE ct.deleted_at IS NULL
       GROUP BY ct.id
       ORDER BY ct.name`,
    )
    .all(officeId) as Array<Record<string, unknown>>;

  const receiptTotals = db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN rl.return_type = 'stitched' THEN rl.qty_pcs END), 0) AS stitched,
       COALESCE(SUM(CASE WHEN rl.return_type = 'unstitched_return' THEN rl.qty_pcs END), 0) AS unstitched
     FROM job_receipt_lines rl
     JOIN job_receipts r ON r.id = rl.job_receipt_id AND r.voided_at IS NULL
     JOIN job_cards j ON j.id = r.job_card_id AND j.voided_at IS NULL AND j.office_id = ?
     WHERE j.contractor_id = ?`,
  );
  const costStmt = db.prepare(
    `SELECT COALESCE(SUM(CAST(ROUND(rl.qty_pcs * l.rate_paise_per_dozen / 12.0) AS INTEGER)), 0) AS cost
     FROM job_receipt_lines rl
     JOIN job_receipts r ON r.id = rl.job_receipt_id AND r.voided_at IS NULL
     JOIN job_card_lines l ON l.id = rl.job_card_line_id
     JOIN job_cards j ON j.id = r.job_card_id AND j.voided_at IS NULL AND j.office_id = ?
     WHERE j.contractor_id = ? AND rl.return_type = 'stitched'`,
  );
  const shortExcessStmt = db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN d.qty_pcs < 0 THEN -d.qty_pcs END), 0) AS shortagePcs,
       COALESCE(SUM(CASE WHEN d.qty_pcs > 0 THEN d.qty_pcs END), 0) AS excessPcs
     FROM discrepancies d
     JOIN job_card_lines l ON d.ref_type = 'job_card_line' AND l.id = d.ref_id
     JOIN job_cards j ON j.id = l.job_card_id AND j.office_id = ?
     WHERE j.contractor_id = ?`,
  );
  const paymentsStmt = db.prepare(
    `SELECT COALESCE(SUM(amount_paise), 0) AS paid FROM contractor_payments
     WHERE contractor_id = ? AND office_id = ? AND voided_at IS NULL`,
  );
  const lastPaymentStmt = db.prepare(
    `SELECT MAX(payment_date) AS lastDate FROM contractor_payments
     WHERE contractor_id = ? AND office_id = ? AND voided_at IS NULL`,
  );
  const turnaroundStmt = db.prepare(
    `SELECT AVG(JULIANDAY(lastReceipt) - JULIANDAY(issue_date)) AS avgDays FROM (
       SELECT j.issue_date, MAX(r.receipt_date) AS lastReceipt
       FROM job_cards j
       JOIN job_receipts r ON r.job_card_id = j.id AND r.voided_at IS NULL
       WHERE j.contractor_id = ? AND j.office_id = ? AND j.status = 'completed' AND j.voided_at IS NULL
       GROUP BY j.id
     )`,
  );

  for (const row of rows) {
    const t = receiptTotals.get(officeId, row.id) as { stitched: number; unstitched: number };
    const cost = (costStmt.get(officeId, row.id) as { cost: number }).cost;
    const se = shortExcessStmt.get(officeId, row.id) as { shortagePcs: number; excessPcs: number };
    const paid = (paymentsStmt.get(row.id, officeId) as { paid: number }).paid;
    const lastPayment = (lastPaymentStmt.get(row.id, officeId) as { lastDate: string | null }).lastDate;
    const turnaround = (turnaroundStmt.get(row.id, officeId) as { avgDays: number | null }).avgDays;
    row.receivedPcs = t.stitched;
    row.unstitchedReturnedPcs = t.unstitched;
    row.shortagePcs = se.shortagePcs;
    row.excessPcs = se.excessPcs;
    const effectiveIssued = (row.issuedPcs as number) - t.unstitched;
    row.discrepancyPct =
      effectiveIssued > 0
        ? Math.round(((se.shortagePcs + se.excessPcs) / effectiveIssued) * 1000) / 10
        : 0;
    row.jobWorkCostPaise = cost;
    row.paidPaise = paid;
    row.duesPaise = cost - paid;
    row.lastPaymentDate = lastPayment;
    row.avgTurnaroundDays = turnaround == null ? null : Math.round(turnaround * 10) / 10;
  }
  return rows;
}

/**
 * The pending-dues view (ADR-036): who is owed what, right now, in this office.
 * Sorted largest dues first; contractors with nothing outstanding drop out.
 */
export function listPendingDues(db: Db, officeId: number): {
  items: Array<Record<string, unknown>>;
  totalDuesPaise: number;
} {
  const rows = contractorAnalytics(db, officeId).filter((r) => (r.duesPaise as number) > 0);
  rows.sort((a, b) => (b.duesPaise as number) - (a.duesPaise as number));
  const items = rows.map((r) => ({
    contractorId: r.id,
    name: r.name,
    mobile: r.mobile,
    jobWorkCostPaise: r.jobWorkCostPaise,
    paidPaise: r.paidPaise,
    duesPaise: r.duesPaise,
    lastPaymentDate: r.lastPaymentDate,
    openJobs: r.openJobs,
  }));
  return {
    items,
    totalDuesPaise: items.reduce((s, r) => s + (r.duesPaise as number), 0),
  };
}

export function createPayment(
  db: Db,
  office: Office,
  input: PaymentInput,
  userId: number,
  ip: string | null,
  onCreated?: (id: number) => void,
): ServiceResult<{ id: number; docNo: string }> {
  const contractor = db
    .prepare('SELECT id FROM contractors WHERE id = ? AND deleted_at IS NULL')
    .get(input.contractorId);
  if (!contractor) return { ok: false, code: 400, error: 'Contractor not found.' };

  let id = 0;
  let docNo = '';
  const tx = db.transaction(() => {
    docNo = nextDocNo(db, 'payment', office);
    const info = db
      .prepare(
        `INSERT INTO contractor_payments (doc_no, office_id, contractor_id, payment_date, amount_paise, mode, reference, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        docNo,
        office.id,
        input.contractorId,
        input.paymentDate,
        input.amountPaise,
        input.mode,
        input.reference,
        input.notes,
        userId,
      );
    id = Number(info.lastInsertRowid);
    audit(db, { userId, action: 'create', entityType: 'contractor_payment', entityId: id, new: { docNo, officeId: office.id, ...input }, ip });
    onCreated?.(id);
  });
  tx();
  return { ok: true, id, docNo };
}

export function voidPayment(
  db: Db,
  office: Office,
  id: number,
  reason: string,
  userId: number,
  ip: string | null,
): ServiceResult {
  const row = db
    .prepare('SELECT * FROM contractor_payments WHERE id = ? AND office_id = ?')
    .get(id, office.id) as Record<string, unknown> | undefined;
  if (!row) return { ok: false, code: 404, error: 'Payment not found.' };
  if (row.voided_at) return { ok: false, code: 409, error: 'Already voided.' };
  const tx = db.transaction(() => {
    db.prepare(
      'UPDATE contractor_payments SET voided_at = ?, void_reason = ?, voided_by = ? WHERE id = ?',
    ).run(nowIso(), reason, userId, id);
    audit(db, { userId, action: 'void', entityType: 'contractor_payment', entityId: id, new: { reason }, ip });
  });
  tx();
  return { ok: true, id };
}

export function listPayments(
  db: Db,
  officeId: number,
  contractorId?: number,
): Array<Record<string, unknown>> {
  const where = contractorId ? 'WHERE p.office_id = ? AND p.contractor_id = ?' : 'WHERE p.office_id = ?';
  const params = contractorId ? [officeId, contractorId] : [officeId];
  return db
    .prepare(
      `SELECT p.id, p.doc_no AS docNo, p.payment_date AS paymentDate, p.amount_paise AS amountPaise,
              p.mode, p.reference, p.notes, p.voided_at AS voidedAt,
              p.contractor_id AS contractorId, ct.name AS contractorName
       FROM contractor_payments p
       JOIN contractors ct ON ct.id = p.contractor_id
       ${where}
       ORDER BY p.id DESC`,
    )
    .all(...params) as Array<Record<string, unknown>>;
}
