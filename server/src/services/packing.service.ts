import type { DispatchInput, PackIssueInput, PackResultInput } from '@shared';
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
 * Module 8/9: packing + finished goods + minimal dispatch.
 * Passed pieces sit in the PACKING pool (check_issue/opening lots, staff NULL).
 * Pack issue: pool → (PACKING, lot=pack_issue, staff=packer).
 * Pack result (incremental): packed → FG (lot=pack_issue); short → terminal + discrepancy.
 * Dispatch (admin): FG FIFO → terminal 'dispatch'; voiding replays the ledger rows back.
 */

function staffCanPack(db: Db, staffId: number): string | null {
  const staff = db
    .prepare('SELECT role, is_active FROM staff WHERE id = ? AND deleted_at IS NULL')
    .get(staffId) as { role: string; is_active: number } | undefined;
  if (!staff) return 'Packer not found.';
  if (!staff.is_active) return 'This staff member is deactivated.';
  if (staff.role !== 'packer' && staff.role !== 'both') return 'This staff member is not a packer.';
  return null;
}

export function createPackIssue(
  db: Db,
  input: PackIssueInput,
  userId: number,
  ip: string | null,
  onCreated?: (id: number) => void,
): ServiceResult<{ id: number; docNo: string }> {
  const staffError = staffCanPack(db, input.staffId);
  if (staffError) return { ok: false, code: 400, error: staffError };

  let id = 0;
  let docNo = '';
  try {
    const tx = db.transaction(() => {
      docNo = nextDocNo(db, 'pack');
      const info = db
        .prepare(
          `INSERT INTO pack_issues (doc_no, issue_date, staff_id, model_id, color_id, size_id, qty_pcs, notes, created_by)
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

      const pool = availableLots(db, {
        stage: 'PACKING',
        modelId: input.modelId,
        colorId: input.colorId,
        sizeId: input.sizeId,
        staffId: null,
      });
      const totalAvailable = pool.reduce((s, l) => s + l.qty, 0);
      if (totalAvailable < input.qtyPcs) {
        throw new LedgerError(
          `Not enough checked stock to pack: needed ${input.qtyPcs} pcs, available ${totalAvailable} pcs.`,
        );
      }
      const takes = splitFifo(pool, input.qtyPcs);
      const insertAlloc = db.prepare(
        `INSERT INTO pack_allocations (pack_issue_id, packing_lot_type, packing_lot_id, qty_pcs)
         VALUES (?, ?, ?, ?)`,
      );
      const movements: Movement[] = [];
      for (const take of takes) {
        movements.push({
          stage: 'PACKING',
          modelId: input.modelId,
          colorId: input.colorId,
          sizeId: input.sizeId,
          lotType: take.lotType,
          lotId: take.lotId,
          qty: -take.qty,
          refType: 'pack_issue',
          refId: id,
        });
        insertAlloc.run(id, take.lotType, take.lotId, take.qty);
      }
      movements.push({
        stage: 'PACKING',
        modelId: input.modelId,
        colorId: input.colorId,
        sizeId: input.sizeId,
        staffId: input.staffId,
        lotType: 'pack_issue',
        lotId: id,
        qty: input.qtyPcs,
        refType: 'pack_issue',
        refId: id,
      });
      postMovements(db, movements, userId);
      audit(db, { userId, action: 'create', entityType: 'pack_issue', entityId: id, new: { docNo, ...input }, ip });
      onCreated?.(id);
    });
    tx();
  } catch (err) {
    if (err instanceof LedgerError) return { ok: false, code: 409, error: err.message };
    throw err;
  }
  return { ok: true, id, docNo };
}

export function recordPackResult(
  db: Db,
  packIssueId: number,
  input: PackResultInput,
  userId: number,
  ip: string | null,
): ServiceResult<{ id: number; status: string }> {
  const issue = db
    .prepare('SELECT * FROM pack_issues WHERE id = ? AND voided_at IS NULL')
    .get(packIssueId) as Record<string, unknown> | undefined;
  if (!issue) return { ok: false, code: 404, error: 'Packing issue not found.' };
  if (issue.status === 'completed') {
    return { ok: false, code: 409, error: 'This packing issue is already completed.' };
  }

  const prior = db
    .prepare(
      `SELECT COALESCE(SUM(qty_packed),0) AS packed, COALESCE(SUM(qty_short),0) AS short
       FROM pack_results WHERE pack_issue_id = ?`,
    )
    .get(packIssueId) as { packed: number; short: number };
  const remaining = (issue.qty_pcs as number) - prior.packed - prior.short;
  const sessionTotal = input.qtyPacked + input.qtyShort;
  if (sessionTotal > remaining) {
    return {
      ok: false,
      code: 409,
      error: `This session covers ${sessionTotal} pcs but only ${remaining} pcs are with the packer.`,
    };
  }

  let resultId = 0;
  let status = 'open';
  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO pack_results (pack_issue_id, result_date, qty_packed, qty_short, short_reason, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        packIssueId,
        input.resultDate,
        input.qtyPacked,
        input.qtyShort,
        input.shortReason ?? null,
        input.notes,
        userId,
      );
    resultId = Number(info.lastInsertRowid);

    const base = {
      modelId: issue.model_id as number,
      colorId: issue.color_id as number,
      sizeId: issue.size_id as number,
    };
    const movements: Movement[] = [];
    if (input.qtyPacked > 0) {
      movements.push(
        {
          ...base,
          stage: 'PACKING',
          staffId: issue.staff_id as number,
          lotType: 'pack_issue',
          lotId: packIssueId,
          qty: -input.qtyPacked,
          refType: 'pack_output',
          refId: resultId,
        },
        {
          ...base,
          stage: 'FG',
          lotType: 'pack_issue',
          lotId: packIssueId,
          qty: input.qtyPacked,
          refType: 'pack_output',
          refId: resultId,
        },
      );
    }
    if (input.qtyShort > 0) {
      movements.push({
        ...base,
        stage: 'PACKING',
        staffId: issue.staff_id as number,
        lotType: 'pack_issue',
        lotId: packIssueId,
        qty: -input.qtyShort,
        refType: 'pack_short',
        refId: resultId,
      });
      db.prepare(
        `INSERT INTO discrepancies (stage, ref_type, ref_id, qty_pcs, reason, note, created_by)
         VALUES ('PACKING', 'pack_result', ?, ?, ?, ?, ?)`,
      ).run(resultId, -input.qtyShort, input.shortReason, input.notes, userId);
    }
    postMovements(db, movements, userId);

    if (sessionTotal === remaining) {
      db.prepare("UPDATE pack_issues SET status = 'completed', completed_at = ? WHERE id = ?").run(
        nowIso(),
        packIssueId,
      );
      status = 'completed';
    }
    audit(db, { userId, action: 'record_result', entityType: 'pack_issue', entityId: packIssueId, new: input, ip });
  });
  tx();
  return { ok: true, id: resultId, status };
}

export function voidPackIssue(
  db: Db,
  packIssueId: number,
  reason: string,
  userId: number,
  ip: string | null,
): ServiceResult {
  const issue = db
    .prepare('SELECT * FROM pack_issues WHERE id = ?')
    .get(packIssueId) as Record<string, unknown> | undefined;
  if (!issue) return { ok: false, code: 404, error: 'Packing issue not found.' };
  if (issue.voided_at) return { ok: false, code: 409, error: 'Already voided.' };
  const results = (
    db
      .prepare('SELECT COUNT(*) AS n FROM pack_results WHERE pack_issue_id = ?')
      .get(packIssueId) as { n: number }
  ).n;
  if (results > 0) {
    return { ok: false, code: 409, error: 'Cannot void: packing results exist for this issue.' };
  }

  const allocations = db
    .prepare(
      'SELECT packing_lot_type, packing_lot_id, qty_pcs FROM pack_allocations WHERE pack_issue_id = ?',
    )
    .all(packIssueId) as Array<{ packing_lot_type: 'check_issue' | 'opening'; packing_lot_id: number; qty_pcs: number }>;

  const base = {
    modelId: issue.model_id as number,
    colorId: issue.color_id as number,
    sizeId: issue.size_id as number,
  };
  const tx = db.transaction(() => {
    postMovements(
      db,
      [
        {
          ...base,
          stage: 'PACKING',
          staffId: issue.staff_id as number,
          lotType: 'pack_issue',
          lotId: packIssueId,
          qty: -(issue.qty_pcs as number),
          refType: 'void_reversal',
          refId: packIssueId,
        },
        ...allocations.map((a) => ({
          ...base,
          stage: 'PACKING' as const,
          lotType: a.packing_lot_type,
          lotId: a.packing_lot_id,
          qty: a.qty_pcs,
          refType: 'void_reversal' as const,
          refId: packIssueId,
        })),
      ],
      userId,
    );
    db.prepare('UPDATE pack_issues SET voided_at = ?, void_reason = ?, voided_by = ? WHERE id = ?').run(
      nowIso(),
      reason,
      userId,
      packIssueId,
    );
    audit(db, { userId, action: 'void', entityType: 'pack_issue', entityId: packIssueId, new: { reason }, ip });
  });
  tx();
  return { ok: true, id: packIssueId };
}

export function listPackIssues(db: Db): Array<Record<string, unknown>> {
  const issues = db
    .prepare(
      `SELECT pi.id, pi.doc_no AS docNo, pi.issue_date AS issueDate, pi.status, pi.notes,
              pi.qty_pcs AS qtyPcs, pi.voided_at AS voidedAt,
              pi.staff_id AS staffId, st.name AS staffName,
              pi.model_id AS modelId, m.code AS modelCode,
              pi.color_id AS colorId, c.name AS colorName,
              pi.size_id AS sizeId, s.code AS sizeCode
       FROM pack_issues pi
       JOIN staff st ON st.id = pi.staff_id
       JOIN models m ON m.id = pi.model_id
       JOIN colors c ON c.id = pi.color_id
       JOIN sizes s ON s.id = pi.size_id
       WHERE pi.voided_at IS NULL
       ORDER BY pi.id DESC`,
    )
    .all() as Array<Record<string, unknown>>;
  const resultsStmt = db.prepare(
    `SELECT id, result_date AS resultDate, qty_packed AS qtyPacked, qty_short AS qtyShort,
            short_reason AS shortReason, notes
     FROM pack_results WHERE pack_issue_id = ? ORDER BY id`,
  );
  for (const issue of issues) {
    const results = resultsStmt.all(issue.id) as Array<Record<string, unknown>>;
    issue.results = results;
    issue.packedPcs = results.reduce((s, r) => s + (r.qtyPacked as number), 0);
    issue.shortPcs = results.reduce((s, r) => s + (r.qtyShort as number), 0);
    issue.pendingPcs =
      (issue.qtyPcs as number) - (issue.packedPcs as number) - (issue.shortPcs as number);
  }
  return issues;
}

// ---------------------------------------------------------------------------
// dispatch (minimal FG stock-out — the full sales module lives on the roadmap)
// ---------------------------------------------------------------------------

export function createDispatch(
  db: Db,
  input: DispatchInput,
  userId: number,
  ip: string | null,
  onCreated?: (id: number) => void,
): ServiceResult<{ id: number; docNo: string }> {
  let id = 0;
  let docNo = '';
  try {
    const tx = db.transaction(() => {
      docNo = nextDocNo(db, 'dispatch');
      const info = db
        .prepare(
          `INSERT INTO fg_dispatches (doc_no, dispatch_date, model_id, color_id, size_id, qty_pcs, notes, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(docNo, input.dispatchDate, input.modelId, input.colorId, input.sizeId, input.qtyPcs, input.notes, userId);
      id = Number(info.lastInsertRowid);

      const lots = availableLots(db, {
        stage: 'FG',
        modelId: input.modelId,
        colorId: input.colorId,
        sizeId: input.sizeId,
      });
      const totalAvailable = lots.reduce((s, l) => s + l.qty, 0);
      if (totalAvailable < input.qtyPcs) {
        throw new LedgerError(
          `Not enough finished goods: needed ${input.qtyPcs} pcs, available ${totalAvailable} pcs.`,
        );
      }
      const takes = splitFifo(lots, input.qtyPcs);
      postMovements(
        db,
        takes.map((take) => ({
          stage: 'FG' as const,
          modelId: input.modelId,
          colorId: input.colorId,
          sizeId: input.sizeId,
          lotType: take.lotType,
          lotId: take.lotId,
          qty: -take.qty,
          refType: 'dispatch' as const,
          refId: id,
        })),
        userId,
      );
      audit(db, { userId, action: 'create', entityType: 'fg_dispatch', entityId: id, new: { docNo, ...input }, ip });
      onCreated?.(id);
    });
    tx();
  } catch (err) {
    if (err instanceof LedgerError) return { ok: false, code: 409, error: err.message };
    throw err;
  }
  return { ok: true, id, docNo };
}

export function voidDispatch(
  db: Db,
  id: number,
  reason: string,
  userId: number,
  ip: string | null,
): ServiceResult {
  const dispatch = db
    .prepare('SELECT * FROM fg_dispatches WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;
  if (!dispatch) return { ok: false, code: 404, error: 'Dispatch not found.' };
  if (dispatch.voided_at) return { ok: false, code: 409, error: 'Already voided.' };

  // the ledger rows themselves record which FG lots were consumed
  const consumed = db
    .prepare(
      `SELECT lot_type, lot_id, -SUM(qty) AS qty FROM stock_ledger
       WHERE ref_type = 'dispatch' AND ref_id = ? GROUP BY lot_type, lot_id`,
    )
    .all(id) as Array<{ lot_type: string; lot_id: number; qty: number }>;

  const tx = db.transaction(() => {
    postMovements(
      db,
      consumed.map((c) => ({
        stage: 'FG' as const,
        modelId: dispatch.model_id as number,
        colorId: dispatch.color_id as number,
        sizeId: dispatch.size_id as number,
        lotType: c.lot_type as never,
        lotId: c.lot_id,
        qty: c.qty,
        refType: 'adjustment_in' as const,
        refId: id,
      })),
      userId,
    );
    db.prepare('UPDATE fg_dispatches SET voided_at = ?, void_reason = ?, voided_by = ? WHERE id = ?').run(
      nowIso(),
      reason,
      userId,
      id,
    );
    audit(db, { userId, action: 'void', entityType: 'fg_dispatch', entityId: id, new: { reason }, ip });
  });
  tx();
  return { ok: true, id };
}

export function listDispatches(db: Db): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT d.id, d.doc_no AS docNo, d.dispatch_date AS dispatchDate, d.qty_pcs AS qtyPcs,
              d.notes, d.voided_at AS voidedAt,
              m.code AS modelCode, c.name AS colorName, s.code AS sizeCode
       FROM fg_dispatches d
       JOIN models m ON m.id = d.model_id
       JOIN colors c ON c.id = d.color_id
       JOIN sizes s ON s.id = d.size_id
       ORDER BY d.id DESC`,
    )
    .all() as Array<Record<string, unknown>>;
}
