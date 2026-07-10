import type { CheckIssueInput, CheckResultInput } from '@shared';
import type { Db } from '../db/connection';
import { nowIso } from '../db/connection';
import { audit } from './audit.service';
import { nextDocNo } from './docNo.service';
import {
  availableLots,
  LedgerError,
  postMovements,
  splitFifo,
  type Movement,
} from './ledger.service';
import type { ServiceResult } from './purchases.service';

/**
 * Module 7: checking. Stitched goods sit in the CHECKING pool (receipt_line/opening lots,
 * staff NULL). Issuing to a checker transfers pool → (CHECKING, lot=check_issue, staff).
 * Results are incremental sessions:  passed → PACKING pool (lot=check_issue),
 * rejected → REJECTED (lot=check_issue), missing → terminal loss + discrepancy.
 */

function staffCanCheck(db: Db, staffId: number): string | null {
  const staff = db
    .prepare('SELECT role, is_active FROM staff WHERE id = ? AND deleted_at IS NULL')
    .get(staffId) as { role: string; is_active: number } | undefined;
  if (!staff) return 'Checker not found.';
  if (!staff.is_active) return 'This staff member is deactivated.';
  if (staff.role !== 'checker' && staff.role !== 'both') {
    return 'This staff member is not a checker.';
  }
  return null;
}

export function createCheckIssue(
  db: Db,
  input: CheckIssueInput,
  userId: number,
  ip: string | null,
  onCreated?: (id: number) => void,
): ServiceResult<{ id: number; docNo: string }> {
  const staffError = staffCanCheck(db, input.staffId);
  if (staffError) return { ok: false, code: 400, error: staffError };

  let id = 0;
  let docNo = '';
  try {
    const tx = db.transaction(() => {
      docNo = nextDocNo(db, 'check');
      const info = db
        .prepare(
          `INSERT INTO check_issues (doc_no, issue_date, staff_id, model_id, color_id, size_id, qty_pcs, notes, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          docNo,
          input.issueDate,
          input.staffId,
          input.modelId,
          input.colorId,
          input.sizeId,
          input.qtyPcs,
          input.notes,
          userId,
        );
      id = Number(info.lastInsertRowid);

      // FIFO from the un-issued CHECKING pool
      const pool = availableLots(db, {
        stage: 'CHECKING',
        modelId: input.modelId,
        colorId: input.colorId,
        sizeId: input.sizeId,
        staffId: null,
      });
      const totalAvailable = pool.reduce((s, l) => s + l.qty, 0);
      if (totalAvailable < input.qtyPcs) {
        throw new LedgerError(
          `Not enough unchecked stock: needed ${input.qtyPcs} pcs, available ${totalAvailable} pcs.`,
        );
      }
      const takes = splitFifo(pool, input.qtyPcs);
      const movements: Movement[] = [];
      const insertAlloc = db.prepare(
        `INSERT INTO check_allocations (check_issue_id, checking_lot_type, checking_lot_id, qty_pcs)
         VALUES (?, ?, ?, ?)`,
      );
      for (const take of takes) {
        movements.push({
          stage: 'CHECKING',
          modelId: input.modelId,
          colorId: input.colorId,
          sizeId: input.sizeId,
          lotType: take.lotType,
          lotId: take.lotId,
          qty: -take.qty,
          refType: 'check_issue',
          refId: id,
        });
        insertAlloc.run(id, take.lotType, take.lotId, take.qty);
      }
      movements.push({
        stage: 'CHECKING',
        modelId: input.modelId,
        colorId: input.colorId,
        sizeId: input.sizeId,
        staffId: input.staffId,
        lotType: 'check_issue',
        lotId: id,
        qty: input.qtyPcs,
        refType: 'check_issue',
        refId: id,
      });
      postMovements(db, movements, userId);
      audit(db, { userId, action: 'create', entityType: 'check_issue', entityId: id, new: { docNo, ...input }, ip });
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
  checkIssueId: number,
  input: CheckResultInput,
  userId: number,
  ip: string | null,
): ServiceResult<{ id: number; status: string }> {
  const issue = db
    .prepare('SELECT * FROM check_issues WHERE id = ? AND voided_at IS NULL')
    .get(checkIssueId) as Record<string, unknown> | undefined;
  if (!issue) return { ok: false, code: 404, error: 'Check issue not found.' };
  if (issue.status === 'completed') {
    return { ok: false, code: 409, error: 'This checking issue is already completed.' };
  }

  const prior = resultTotals(db, checkIssueId);
  const sessionTotal = input.qtyPassed + input.qtyRejected + input.qtyMissing;
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
      .run(
        checkIssueId,
        input.resultDate,
        input.qtyPassed,
        input.qtyRejected,
        input.qtyMissing,
        input.notes,
        userId,
      );
    resultId = Number(info.lastInsertRowid);
    const insertRejection = db.prepare(
      'INSERT INTO check_result_rejections (check_result_id, reason, qty_pcs) VALUES (?, ?, ?)',
    );
    for (const rej of input.rejections) insertRejection.run(resultId, rej.reason, rej.qtyPcs);

    const base = {
      modelId: issue.model_id as number,
      colorId: issue.color_id as number,
      sizeId: issue.size_id as number,
    };
    const movements: Movement[] = [];
    const outFromChecker = input.qtyPassed + input.qtyRejected + input.qtyMissing;
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
    if (input.qtyRejected > 0) {
      movements.push(
        {
          ...base,
          stage: 'CHECKING',
          staffId: issue.staff_id as number,
          lotType: 'check_issue',
          lotId: checkIssueId,
          qty: -input.qtyRejected,
          refType: 'check_reject',
          refId: resultId,
        },
        {
          ...base,
          stage: 'REJECTED',
          lotType: 'check_issue',
          lotId: checkIssueId,
          qty: input.qtyRejected,
          refType: 'check_reject',
          refId: resultId,
        },
      );
      db.prepare(
        `INSERT INTO discrepancies (stage, ref_type, ref_id, qty_pcs, reason, note, created_by)
         VALUES ('CHECKING', 'check_result', ?, ?, ?, ?, ?)`,
      ).run(
        resultId,
        -input.qtyRejected,
        input.rejections[0]?.reason ?? 'other',
        input.notes,
        userId,
      );
    }
    if (input.qtyMissing > 0) {
      movements.push({
        ...base,
        stage: 'CHECKING',
        staffId: issue.staff_id as number,
        lotType: 'check_issue',
        lotId: checkIssueId,
        qty: -input.qtyMissing,
        refType: 'check_missing',
        refId: resultId,
      });
      db.prepare(
        `INSERT INTO discrepancies (stage, ref_type, ref_id, qty_pcs, reason, note, created_by)
         VALUES ('CHECKING', 'check_result', ?, ?, 'missing', ?, ?)`,
      ).run(resultId, -input.qtyMissing, input.notes, userId);
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
  checkIssueId: number,
  reason: string,
  userId: number,
  ip: string | null,
): ServiceResult {
  const issue = db
    .prepare('SELECT * FROM check_issues WHERE id = ?')
    .get(checkIssueId) as Record<string, unknown> | undefined;
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

export function listCheckIssues(db: Db): Array<Record<string, unknown>> {
  const issues = db
    .prepare(
      `SELECT ci.id, ci.doc_no AS docNo, ci.issue_date AS issueDate, ci.status, ci.notes,
              ci.qty_pcs AS qtyPcs, ci.voided_at AS voidedAt,
              ci.staff_id AS staffId, st.name AS staffName,
              ci.model_id AS modelId, m.code AS modelCode,
              ci.color_id AS colorId, c.name AS colorName,
              ci.size_id AS sizeId, s.code AS sizeCode
       FROM check_issues ci
       JOIN staff st ON st.id = ci.staff_id
       JOIN models m ON m.id = ci.model_id
       JOIN colors c ON c.id = ci.color_id
       JOIN sizes s ON s.id = ci.size_id
       WHERE ci.voided_at IS NULL
       ORDER BY ci.id DESC`,
    )
    .all() as Array<Record<string, unknown>>;
  const resultsStmt = db.prepare(
    `SELECT r.id, r.result_date AS resultDate, r.qty_passed AS qtyPassed, r.qty_rejected AS qtyRejected,
            r.qty_missing AS qtyMissing, r.notes
     FROM check_results r WHERE r.check_issue_id = ? ORDER BY r.id`,
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
  }
  return issues;
}
