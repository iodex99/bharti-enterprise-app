import type { StaffPaymentInput } from '@shared';
import type { Db } from '../db/connection';
import { nowIso } from '../db/connection';
import { audit } from './audit.service';
import { nextDocNo } from './docNo.service';
import type { Office } from './offices.service';
import type { ServiceResult } from './purchases.service';

/**
 * Checkers & packers get paid per dozen too. Earnings accrue from RESULTS at the rate
 * snapshotted on each issue: checking pays for pieces actually inspected (passed +
 * rejected), packing pays for pieces packed. Dues = earnings − payments, exactly like
 * contractors; payments are partial and dated.
 *
 * MISSING pieces are deliberately NOT paid: they never reached the checker, and paying
 * for them would reward declaring goods missing — which also writes stock off.
 */

export function staffAnalytics(db: Db, officeId: number): Array<Record<string, unknown>> {
  const rows = db
    .prepare(
      `SELECT st.id, st.name, st.mobile, st.is_active AS isActive,
              st.default_rate_paise_per_dozen AS defaultRatePaisePerDozen,
              st.image_path AS imagePath
       FROM staff st
       WHERE st.deleted_at IS NULL
       ORDER BY st.name`,
    )
    .all() as Array<Record<string, unknown>>;

  // rounded once per check issue over everything inspected on it, so the figure here
  // matches what the checking page shows for that batch
  const checkStmt = db.prepare(
    `SELECT COALESCE(SUM(pcs), 0) AS pcs, COALESCE(SUM(earned), 0) AS earned FROM (
       SELECT SUM(r.qty_passed + r.qty_rejected) AS pcs,
              CAST(ROUND(SUM(r.qty_passed + r.qty_rejected) * ci.rate_paise_per_dozen / 12.0) AS INTEGER) AS earned
       FROM check_results r
       JOIN check_issues ci ON ci.id = r.check_issue_id AND ci.voided_at IS NULL
       WHERE ci.staff_id = ? AND ci.office_id = ?
       GROUP BY ci.id
     )`,
  );
  const packStmt = db.prepare(
    `SELECT COALESCE(SUM(pcs), 0) AS pcs, COALESCE(SUM(earned), 0) AS earned FROM (
       SELECT SUM(pr.qty_packed) AS pcs,
              CAST(ROUND(SUM(pr.qty_packed) * pi.rate_paise_per_dozen / 12.0) AS INTEGER) AS earned
       FROM pack_results pr
       JOIN pack_issues pi ON pi.id = pr.pack_issue_id AND pi.voided_at IS NULL
       WHERE pi.staff_id = ? AND pi.office_id = ?
       GROUP BY pi.id
     )`,
  );
  const paidStmt = db.prepare(
    `SELECT COALESCE(SUM(amount_paise), 0) AS paid, MAX(payment_date) AS lastDate
     FROM staff_payments WHERE staff_id = ? AND office_id = ? AND voided_at IS NULL`,
  );

  for (const row of rows) {
    const check = checkStmt.get(row.id, officeId) as { pcs: number; earned: number };
    const pack = packStmt.get(row.id, officeId) as { pcs: number; earned: number };
    const paid = paidStmt.get(row.id, officeId) as { paid: number; lastDate: string | null };
    row.checkedPcs = check.pcs;
    row.packedPcs = pack.pcs;
    row.earnedPaise = check.earned + pack.earned;
    row.paidPaise = paid.paid;
    row.duesPaise = (row.earnedPaise as number) - paid.paid;
    row.lastPaymentDate = paid.lastDate;
  }
  return rows;
}

/** Staff pending dues, largest first; fully-paid staff drop out (mirrors contractors). */
export function listStaffDues(
  db: Db,
  officeId: number,
): {
  items: Array<Record<string, unknown>>;
  totalDuesPaise: number;
} {
  const rows = staffAnalytics(db, officeId).filter((r) => (r.duesPaise as number) > 0);
  rows.sort((a, b) => (b.duesPaise as number) - (a.duesPaise as number));
  const items = rows.map((r) => ({
    staffId: r.id,
    name: r.name,
    mobile: r.mobile,
    imagePath: r.imagePath,
    checkedPcs: r.checkedPcs,
    packedPcs: r.packedPcs,
    earnedPaise: r.earnedPaise,
    paidPaise: r.paidPaise,
    duesPaise: r.duesPaise,
    lastPaymentDate: r.lastPaymentDate,
  }));
  return { items, totalDuesPaise: items.reduce((s, r) => s + (r.duesPaise as number), 0) };
}

export function createStaffPayment(
  db: Db,
  office: Office,
  input: StaffPaymentInput,
  userId: number,
  ip: string | null,
  onCreated?: (id: number) => void,
): ServiceResult<{ id: number; docNo: string }> {
  const staff = db
    .prepare('SELECT id, name FROM staff WHERE id = ? AND deleted_at IS NULL')
    .get(input.staffId) as { id: number; name: string } | undefined;
  if (!staff) return { ok: false, code: 400, error: 'Staff member not found.' };

  // Earnings are per office, so a payment booked in the wrong office settles nothing:
  // the money leaves, and the dues it was meant to clear stay on the other office's
  // page forever. Refuse rather than record a payment that can never balance.
  const workedHere = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM check_issues WHERE staff_id = ? AND office_id = ?) +
         (SELECT COUNT(*) FROM pack_issues  WHERE staff_id = ? AND office_id = ?) AS n`,
    )
    .get(input.staffId, office.id, input.staffId, office.id) as { n: number };
  if (workedHere.n === 0) {
    return {
      ok: false,
      code: 400,
      error: `${staff.name} has not checked or packed anything in ${office.name}. Switch to the office where the work was done.`,
    };
  }

  let id = 0;
  let docNo = '';
  const tx = db.transaction(() => {
    docNo = nextDocNo(db, 'staff_payment', office);
    const info = db
      .prepare(
        `INSERT INTO staff_payments (doc_no, office_id, staff_id, payment_date, amount_paise, mode, reference, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        docNo,
        office.id,
        input.staffId,
        input.paymentDate,
        input.amountPaise,
        input.mode,
        input.reference,
        input.notes,
        userId,
      );
    id = Number(info.lastInsertRowid);
    audit(db, {
      userId,
      action: 'create',
      entityType: 'staff_payment',
      entityId: id,
      new: { docNo, officeId: office.id, ...input },
      ip,
    });
    onCreated?.(id);
  });
  tx();
  return { ok: true, id, docNo };
}

export function voidStaffPayment(
  db: Db,
  office: Office,
  id: number,
  reason: string,
  userId: number,
  ip: string | null,
): ServiceResult {
  const row = db
    .prepare('SELECT * FROM staff_payments WHERE id = ? AND office_id = ?')
    .get(id, office.id) as Record<string, unknown> | undefined;
  if (!row) return { ok: false, code: 404, error: 'Payment not found.' };
  if (row.voided_at) return { ok: false, code: 409, error: 'Already voided.' };
  const tx = db.transaction(() => {
    db.prepare(
      'UPDATE staff_payments SET voided_at = ?, void_reason = ?, voided_by = ? WHERE id = ?',
    ).run(nowIso(), reason, userId, id);
    audit(db, {
      userId,
      action: 'void',
      entityType: 'staff_payment',
      entityId: id,
      new: { reason },
      ip,
    });
  });
  tx();
  return { ok: true, id };
}

export function listStaffPayments(
  db: Db,
  officeId: number,
  staffId?: number,
): Array<Record<string, unknown>> {
  const where = staffId ? 'WHERE p.office_id = ? AND p.staff_id = ?' : 'WHERE p.office_id = ?';
  const params = staffId ? [officeId, staffId] : [officeId];
  return db
    .prepare(
      `SELECT p.id, p.doc_no AS docNo, p.payment_date AS paymentDate, p.amount_paise AS amountPaise,
              p.mode, p.reference, p.notes, p.voided_at AS voidedAt,
              p.staff_id AS staffId, st.name AS staffName
       FROM staff_payments p
       JOIN staff st ON st.id = p.staff_id
       ${where}
       ORDER BY p.id DESC`,
    )
    .all(...params) as Array<Record<string, unknown>>;
}
