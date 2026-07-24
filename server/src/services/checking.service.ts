import type { CheckIssueInput, CheckResultInput } from '@shared';
import type { Db } from '../db/connection';
import { nowIso } from '../db/connection';
import { audit } from './audit.service';
import { nextDocNo } from './docNo.service';
import { LedgerError, postMovements, type Movement } from './ledger.service';
import type { Office } from './offices.service';
import type { ServiceResult } from './purchases.service';

/**
 * Module 4: checking (v2, ADR-034/035).
 * Stitched goods a contractor claims to have returned sit in the CHECKING pool
 * (receipt_line/opening lots, staff NULL) — "pending for checking". Issuing to a
 * checker is DIRECTED: the user picks the specific received batch, so the contractor ↔
 * checker mapping is explicit and shortfalls trace to that contractor.
 *
 * Results are incremental sessions with ONE rejected box broken down by reason.
 * 'missing' is a reason in that dropdown for the user, but internally missing pieces
 * are a terminal write-off (they do not physically exist to sit in REJECTED stock):
 *   passed → PACKING pool (lot = check_issue) ; rejected → REJECTED ; missing → gone.
 * Packing is allotted from the checking page (packing.service) — usually to the same
 * person who checked.
 */

export function staffUsable(db: Db, staffId: number, label: string): string | null {
  // any active staff member can check or pack — no fixed roles
  const staff = db
    .prepare('SELECT is_active FROM staff WHERE id = ? AND deleted_at IS NULL')
    .get(staffId) as { is_active: number } | undefined;
  if (!staff) return `${label} not found.`;
  if (!staff.is_active) return 'This staff member is deactivated.';
  return null;
}

type PoolLotInfo = {
  modelId: number;
  colorId: number;
  sizeId: number;
  available: number;
  label: string;
};

/** Dimensions + remaining pool balance of one specific un-checked lot (office-scoped). */
function poolLotInfo(
  db: Db,
  office: Office,
  lotType: 'receipt_line' | 'opening',
  lotId: number,
): PoolLotInfo | null {
  const bal = (
    db
      .prepare(
        `SELECT COALESCE(SUM(qty),0) AS bal FROM stock_ledger
         WHERE stage = 'CHECKING' AND office_id = ? AND staff_id IS NULL AND lot_type = ? AND lot_id = ?`,
      )
      .get(office.id, lotType, lotId) as { bal: number }
  ).bal;
  if (lotType === 'receipt_line') {
    const rl = db
      .prepare(
        `SELECT r.doc_no AS docNo, jc.model_id, jc.color_id, jl.size_id
         FROM job_receipt_lines rl
         JOIN job_receipts r ON r.id = rl.job_receipt_id
         JOIN job_card_lines jl ON jl.id = rl.job_card_line_id
         JOIN job_cards jc ON jc.id = r.job_card_id AND jc.office_id = ?
         WHERE rl.id = ? AND r.voided_at IS NULL`,
      )
      .get(office.id, lotId) as
      | { docNo: string; model_id: number; color_id: number; size_id: number }
      | undefined;
    if (!rl) return null;
    return { modelId: rl.model_id, colorId: rl.color_id, sizeId: rl.size_id, available: bal, label: rl.docNo };
  }
  const o = db
    .prepare(
      `SELECT doc_no AS docNo, model_id, color_id, size_id FROM opening_balances
       WHERE id = ? AND office_id = ? AND stage = 'CHECKING' AND voided_at IS NULL`,
    )
    .get(lotId, office.id) as
    | { docNo: string; model_id: number; color_id: number; size_id: number }
    | undefined;
  if (!o) return null;
  return { modelId: o.model_id, colorId: o.color_id, sizeId: o.size_id, available: bal, label: o.docNo };
}

/**
 * The "pending for checking" list: every received-but-unchecked batch with its
 * contractor, receipt document, photo and remaining quantity.
 */
export function listPendingChecking(db: Db, officeId: number): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT l.lot_type AS lotType, l.lot_id AS lotId, SUM(l.qty) AS qtyPcs,
              m.code AS code, s.code AS sizeCode, m.code || '-' || s.code AS sizeCodeLabel,
              m.image_path AS codeImagePath, c.name AS colorName,
              r.doc_no AS receiptDocNo, r.receipt_date AS receiptDate, r.image_path AS imagePath,
              jc.doc_no AS jobDocNo, ct.name AS contractorName,
              o.doc_no AS openingDocNo
       FROM stock_ledger l
       JOIN models m ON m.id = l.model_id
       JOIN colors c ON c.id = l.color_id
       JOIN sizes s ON s.id = l.size_id
       LEFT JOIN job_receipt_lines rl ON l.lot_type = 'receipt_line' AND rl.id = l.lot_id
       LEFT JOIN job_receipts r ON r.id = rl.job_receipt_id
       LEFT JOIN job_cards jc ON jc.id = r.job_card_id
       LEFT JOIN contractors ct ON ct.id = jc.contractor_id
       LEFT JOIN opening_balances o ON l.lot_type = 'opening' AND o.id = l.lot_id
       WHERE l.stage = 'CHECKING' AND l.office_id = ? AND l.staff_id IS NULL
       GROUP BY l.lot_type, l.lot_id
       HAVING SUM(l.qty) > 0
       ORDER BY COALESCE(r.receipt_date, o.balance_date), l.lot_id`,
    )
    .all(officeId) as Array<Record<string, unknown>>;
}

export function createCheckIssue(
  db: Db,
  office: Office,
  input: CheckIssueInput,
  userId: number,
  ip: string | null,
  onCreated?: (id: number) => void,
): ServiceResult<{ id: number; docNo: string }> {
  const staffError = staffUsable(db, input.staffId, 'Checker');
  if (staffError) return { ok: false, code: 400, error: staffError };
  const lot = poolLotInfo(db, office, input.lotType, input.lotId);
  if (!lot) return { ok: false, code: 400, error: 'That received batch was not found.' };
  if (lot.available < input.qtyPcs) {
    return {
      ok: false,
      code: 409,
      error: `Batch ${lot.label} has only ${lot.available} pcs waiting for checking.`,
    };
  }

  let id = 0;
  let docNo = '';
  try {
    const tx = db.transaction(() => {
      docNo = nextDocNo(db, 'check', office);
      const info = db
        .prepare(
          `INSERT INTO check_issues (doc_no, office_id, issue_date, staff_id, model_id, color_id, size_id, qty_pcs, notes, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          docNo,
          office.id,
          input.issueDate,
          input.staffId,
          lot.modelId,
          lot.colorId,
          lot.sizeId,
          input.qtyPcs,
          input.notes,
          userId,
        );
      id = Number(info.lastInsertRowid);

      // directed take from the chosen batch (recorded for traceability)
      db.prepare(
        `INSERT INTO check_allocations (check_issue_id, checking_lot_type, checking_lot_id, qty_pcs)
         VALUES (?, ?, ?, ?)`,
      ).run(id, input.lotType, input.lotId, input.qtyPcs);
      const movements: Movement[] = [
        {
          stage: 'CHECKING',
          officeId: office.id,
          modelId: lot.modelId,
          colorId: lot.colorId,
          sizeId: lot.sizeId,
          lotType: input.lotType,
          lotId: input.lotId,
          qty: -input.qtyPcs,
          refType: 'check_issue',
          refId: id,
        },
        {
          stage: 'CHECKING',
          officeId: office.id,
          modelId: lot.modelId,
          colorId: lot.colorId,
          sizeId: lot.sizeId,
          staffId: input.staffId,
          lotType: 'check_issue',
          lotId: id,
          qty: input.qtyPcs,
          refType: 'check_issue',
          refId: id,
        },
      ];
      postMovements(db, movements, userId);
      audit(db, { userId, action: 'create', entityType: 'check_issue', entityId: id, new: { docNo, officeId: office.id, ...input }, ip });
      onCreated?.(id);
    });
    tx();
  } catch (err) {
    if (err instanceof LedgerError) return { ok: false, code: 409, error: err.message };
    throw err;
  }
  return { ok: true, id, docNo };
}

function resultTotals(db: Db, checkIssueId: number): { passed: number; rejected: number; missing: number } {
  return db
    .prepare(
      `SELECT COALESCE(SUM(qty_passed),0) AS passed, COALESCE(SUM(qty_rejected),0) AS rejected,
              COALESCE(SUM(qty_missing),0) AS missing
       FROM check_results WHERE check_issue_id = ?`,
    )
    .get(checkIssueId) as { passed: number; rejected: number; missing: number };
}

export function recordCheckResult(
  db: Db,
  office: Office,
  checkIssueId: number,
  input: CheckResultInput,
  userId: number,
  ip: string | null,
): ServiceResult<{ id: number; status: string }> {
  const issue = db
    .prepare('SELECT * FROM check_issues WHERE id = ? AND office_id = ? AND voided_at IS NULL')
    .get(checkIssueId, office.id) as Record<string, unknown> | undefined;
  if (!issue) return { ok: false, code: 404, error: 'Check issue not found.' };
  if (issue.status === 'completed') {
    return { ok: false, code: 409, error: 'This checking issue is already completed.' };
  }

  // ONE rejected box for the user; 'missing' splits out internally (ADR-034)
  const qtyMissing = input.rejections
    .filter((r) => r.reason === 'missing')
    .reduce((s, r) => s + r.qtyPcs, 0);
  const realRejections = input.rejections.filter((r) => r.reason !== 'missing');
  const qtyRejected = realRejections.reduce((s, r) => s + r.qtyPcs, 0);

  const prior = resultTotals(db, checkIssueId);
  const sessionTotal = input.qtyPassed + qtyRejected + qtyMissing;
  const remaining = (issue.qty_pcs as number) - prior.passed - prior.rejected - prior.missing;
  if (sessionTotal > remaining) {
    return {
      ok: false,
      code: 409,
      error: `This session covers ${sessionTotal} pcs but only ${remaining} pcs are still with the checker.`,
    };
  }

  let resultId = 0;
  let status = 'open';
  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO check_results (check_issue_id, result_date, qty_passed, qty_rejected, qty_missing, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(checkIssueId, input.resultDate, input.qtyPassed, qtyRejected, qtyMissing, input.notes, userId);
    resultId = Number(info.lastInsertRowid);
    const insertRejection = db.prepare(
      'INSERT INTO check_result_rejections (check_result_id, reason, qty_pcs) VALUES (?, ?, ?)',
    );
    for (const rej of realRejections) insertRejection.run(resultId, rej.reason, rej.qtyPcs);

    const base = {
      officeId: office.id,
      modelId: issue.model_id as number,
      colorId: issue.color_id as number,
      sizeId: issue.size_id as number,
    };
    const movements: Movement[] = [];
    const outFromChecker = sessionTotal;
    // one negative row per destination keeps the transfer pairs balanced
    if (input.qtyPassed > 0) {
      movements.push(
        {
          ...base,
          stage: 'CHECKING',
          staffId: issue.staff_id as number,
          lotType: 'check_issue',
          lotId: checkIssueId,
          qty: -input.qtyPassed,
          refType: 'check_pass',
          refId: resultId,
        },
        {
          ...base,
          stage: 'PACKING',
          lotType: 'check_issue',
          lotId: checkIssueId,
          qty: input.qtyPassed,
          refType: 'check_pass',
          refId: resultId,
        },
      );
    }
    if (qtyRejected > 0) {
      movements.push(
        {
          ...base,
          stage: 'CHECKING',
          staffId: issue.staff_id as number,
          lotType: 'check_issue',
          lotId: checkIssueId,
          qty: -qtyRejected,
          refType: 'check_reject',
          refId: resultId,
        },
        {
          ...base,
          stage: 'REJECTED',
          lotType: 'check_issue',
          lotId: checkIssueId,
          qty: qtyRejected,
          refType: 'check_reject',
          refId: resultId,
        },
      );
      db.prepare(
        `INSERT INTO discrepancies (stage, office_id, ref_type, ref_id, qty_pcs, reason, note, created_by)
         VALUES ('CHECKING', ?, 'check_result', ?, ?, ?, ?, ?)`,
      ).run(
        office.id,
        resultId,
        -qtyRejected,
        realRejections[0]?.reason ?? 'other',
        input.notes,
        userId,
      );
    }
    if (qtyMissing > 0) {
      movements.push({
        ...base,
        stage: 'CHECKING',
        staffId: issue.staff_id as number,
        lotType: 'check_issue',
        lotId: checkIssueId,
        qty: -qtyMissing,
        refType: 'check_missing',
        refId: resultId,
      });
      db.prepare(
        `INSERT INTO discrepancies (stage, office_id, ref_type, ref_id, qty_pcs, reason, note, created_by)
         VALUES ('CHECKING', ?, 'check_result', ?, ?, 'missing', ?, ?)`,
      ).run(office.id, resultId, -qtyMissing, input.notes, userId);
    }
    postMovements(db, movements, userId);

    if (outFromChecker === remaining) {
      db.prepare("UPDATE check_issues SET status = 'completed', completed_at = ? WHERE id = ?").run(
        nowIso(),
        checkIssueId,
      );
      status = 'completed';
    }
    audit(db, {
      userId,
      action: 'record_result',
      entityType: 'check_issue',
      entityId: checkIssueId,
      new: input,
      ip,
    });
  });
  tx();
  return { ok: true, id: resultId, status };
}

export function voidCheckIssue(
  db: Db,
  office: Office,
  checkIssueId: number,
  reason: string,
  userId: number,
  ip: string | null,
): ServiceResult {
  const issue = db
    .prepare('SELECT * FROM check_issues WHERE id = ? AND office_id = ?')
    .get(checkIssueId, office.id) as Record<string, unknown> | undefined;
  if (!issue) return { ok: false, code: 404, error: 'Check issue not found.' };
  if (issue.voided_at) return { ok: false, code: 409, error: 'Already voided.' };
  const results = (
    db
      .prepare('SELECT COUNT(*) AS n FROM check_results WHERE check_issue_id = ?')
      .get(checkIssueId) as { n: number }
  ).n;
  if (results > 0) {
    return { ok: false, code: 409, error: 'Cannot void: checking results exist for this issue.' };
  }

  const allocations = db
    .prepare(
      'SELECT checking_lot_type, checking_lot_id, qty_pcs FROM check_allocations WHERE check_issue_id = ?',
    )
    .all(checkIssueId) as Array<{ checking_lot_type: 'receipt_line' | 'opening'; checking_lot_id: number; qty_pcs: number }>;

  const base = {
    officeId: office.id,
    modelId: issue.model_id as number,
    colorId: issue.color_id as number,
    sizeId: issue.size_id as number,
  };
  const tx = db.transaction(() => {
    const movements: Movement[] = [
      {
        ...base,
        stage: 'CHECKING',
        staffId: issue.staff_id as number,
        lotType: 'check_issue',
        lotId: checkIssueId,
        qty: -(issue.qty_pcs as number),
        refType: 'void_reversal',
        refId: checkIssueId,
      },
      ...allocations.map((a) => ({
        ...base,
        stage: 'CHECKING' as const,
        lotType: a.checking_lot_type,
        lotId: a.checking_lot_id,
        qty: a.qty_pcs,
        refType: 'void_reversal' as const,
        refId: checkIssueId,
      })),
    ];
    postMovements(db, movements, userId);
    db.prepare('UPDATE check_issues SET voided_at = ?, void_reason = ?, voided_by = ? WHERE id = ?').run(
      nowIso(),
      reason,
      userId,
      checkIssueId,
    );
    audit(db, { userId, action: 'void', entityType: 'check_issue', entityId: checkIssueId, new: { reason }, ip });
  });
  tx();
  return { ok: true, id: checkIssueId };
}

export function listCheckIssues(db: Db, officeId: number): Array<Record<string, unknown>> {
  // first allocation → source receipt line → contractor: the checker ↔ contractor mapping
  const issues = db
    .prepare(
      `SELECT ci.id, ci.doc_no AS docNo, ci.issue_date AS issueDate, ci.status, ci.notes,
              ci.qty_pcs AS qtyPcs, ci.voided_at AS voidedAt,
              ci.staff_id AS staffId, st.name AS staffName,
              ci.model_id AS modelId, m.code AS code, m.image_path AS codeImagePath,
              m.code || '-' || s.code AS sizeCodeLabel,
              ci.color_id AS colorId, c.name AS colorName,
              ci.size_id AS sizeId, s.code AS sizeCode,
              ct.name AS contractorName, r.doc_no AS receiptDocNo, r.image_path AS receiptImagePath
       FROM check_issues ci
       JOIN staff st ON st.id = ci.staff_id
       JOIN models m ON m.id = ci.model_id
       JOIN colors c ON c.id = ci.color_id
       JOIN sizes s ON s.id = ci.size_id
       LEFT JOIN check_allocations a ON a.id =
         (SELECT MIN(a2.id) FROM check_allocations a2
          WHERE a2.check_issue_id = ci.id AND a2.checking_lot_type = 'receipt_line')
       LEFT JOIN job_receipt_lines rl ON rl.id = a.checking_lot_id
       LEFT JOIN job_receipts r ON r.id = rl.job_receipt_id
       LEFT JOIN job_cards jc ON jc.id = r.job_card_id
       LEFT JOIN contractors ct ON ct.id = jc.contractor_id
       WHERE ci.voided_at IS NULL AND ci.office_id = ?
       ORDER BY ci.id DESC`,
    )
    .all(officeId) as Array<Record<string, unknown>>;
  const resultsStmt = db.prepare(
    `SELECT r.id, r.result_date AS resultDate, r.qty_passed AS qtyPassed, r.qty_rejected AS qtyRejected,
            r.qty_missing AS qtyMissing, r.notes
     FROM check_results r WHERE r.check_issue_id = ? ORDER BY r.id`,
  );
  // passed pieces still waiting (not yet allotted to packing / kept as a bundle)
  const packableStmt = db.prepare(
    `SELECT COALESCE(SUM(qty),0) AS bal FROM stock_ledger
     WHERE stage='PACKING' AND staff_id IS NULL AND lot_type='check_issue' AND lot_id = ?`,
  );
  for (const issue of issues) {
    const results = resultsStmt.all(issue.id) as Array<Record<string, unknown>>;
    issue.results = results;
    issue.passedPcs = results.reduce((s, r) => s + (r.qtyPassed as number), 0);
    issue.rejectedPcs = results.reduce((s, r) => s + (r.qtyRejected as number), 0);
    issue.missingPcs = results.reduce((s, r) => s + (r.qtyMissing as number), 0);
    issue.pendingPcs =
      (issue.qtyPcs as number) -
      (issue.passedPcs as number) -
      (issue.rejectedPcs as number) -
      (issue.missingPcs as number);
    issue.packablePcs = (packableStmt.get(issue.id) as { bal: number }).bal;
  }
  return issues;
}
