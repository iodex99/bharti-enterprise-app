import type { DispatchInput, PackIssueInput, PackResultInput } from '@shared';
import type { Db } from '../db/connection';
import { nowIso } from '../db/connection';
import { audit } from './audit.service';
import { staffDefaultRate, staffUsable } from './checking.service';
import { nextDocNo } from './docNo.service';
import {
  availableLots,
  LedgerError,
  postMovements,
  splitFifo,
  type Movement,
} from './ledger.service';
import type { Office } from './offices.service';
import type { ServiceResult } from './purchases.service';

/**
 * Module 5: packing + bundles + finished goods + minimal dispatch (v2, ADR-035).
 * There is no separate packing module: packing is ALLOTTED FROM THE CHECKING PAGE,
 * directed at a specific source lot — a checker's passed goods (usually packed by the
 * same person), an opening lot, or a BUNDLE.
 *
 * A bundle (kind='bundle') is checked goods the owner asked to keep aside, labeled, to
 * be packed later — it holds its pieces in the PACKING stage until used.
 *
 * Ledger: allot   PACKING −(source lot) → PACKING +(lot=pack_issue, staff=packer).
 *         result  packed → FG (lot=pack_issue); short → terminal + discrepancy.
 *         dispatch (admin): FG FIFO → terminal 'dispatch'; void replays the rows back.
 */

type PackSource = {
  modelId: number;
  colorId: number;
  sizeId: number;
  available: number;
  /** staff currently holding the source lot (bundles); null for pool lots */
  holderStaffId: number | null;
  label: string;
};

function packSourceInfo(
  db: Db,
  office: Office,
  lotType: 'check_issue' | 'opening' | 'pack_issue',
  lotId: number,
): PackSource | null {
  if (lotType === 'check_issue') {
    const ci = db
      .prepare(
        `SELECT doc_no, model_id, color_id, size_id FROM check_issues
         WHERE id = ? AND office_id = ? AND voided_at IS NULL`,
      )
      .get(lotId, office.id) as
      | { doc_no: string; model_id: number; color_id: number; size_id: number }
      | undefined;
    if (!ci) return null;
    const bal = (
      db
        .prepare(
          `SELECT COALESCE(SUM(qty),0) AS bal FROM stock_ledger
           WHERE stage='PACKING' AND office_id = ? AND staff_id IS NULL AND lot_type='check_issue' AND lot_id = ?`,
        )
        .get(office.id, lotId) as { bal: number }
    ).bal;
    return {
      modelId: ci.model_id,
      colorId: ci.color_id,
      sizeId: ci.size_id,
      available: bal,
      holderStaffId: null,
      label: ci.doc_no,
    };
  }
  if (lotType === 'opening') {
    const o = db
      .prepare(
        `SELECT doc_no, model_id, color_id, size_id FROM opening_balances
         WHERE id = ? AND office_id = ? AND stage = 'PACKING' AND voided_at IS NULL`,
      )
      .get(lotId, office.id) as
      | { doc_no: string; model_id: number; color_id: number; size_id: number }
      | undefined;
    if (!o) return null;
    const bal = (
      db
        .prepare(
          `SELECT COALESCE(SUM(qty),0) AS bal FROM stock_ledger
           WHERE stage='PACKING' AND office_id = ? AND staff_id IS NULL AND lot_type='opening' AND lot_id = ?`,
        )
        .get(office.id, lotId) as { bal: number }
    ).bal;
    return {
      modelId: o.model_id,
      colorId: o.color_id,
      sizeId: o.size_id,
      available: bal,
      holderStaffId: null,
      label: o.doc_no,
    };
  }
  // pack_issue source = an existing BUNDLE being used for packing
  const bundle = db
    .prepare(
      `SELECT doc_no, model_id, color_id, size_id, staff_id, kind FROM pack_issues
       WHERE id = ? AND office_id = ? AND voided_at IS NULL`,
    )
    .get(lotId, office.id) as
    | { doc_no: string; model_id: number; color_id: number; size_id: number; staff_id: number; kind: string }
    | undefined;
  if (!bundle || bundle.kind !== 'bundle') return null;
  const bal = (
    db
      .prepare(
        `SELECT COALESCE(SUM(qty),0) AS bal FROM stock_ledger
         WHERE stage='PACKING' AND office_id = ? AND lot_type='pack_issue' AND lot_id = ?`,
      )
      .get(office.id, lotId) as { bal: number }
  ).bal;
  return {
    modelId: bundle.model_id,
    colorId: bundle.color_id,
    sizeId: bundle.size_id,
    available: bal,
    holderStaffId: bundle.staff_id,
    label: bundle.doc_no,
  };
}

/**
 * Allot packing (or keep a bundle aside) from a specific source lot. Directed, like
 * checking — the checker↔packer mapping is explicit, and the default packer in the UI
 * is the person who checked the goods.
 */
export function createPackIssue(
  db: Db,
  office: Office,
  input: PackIssueInput,
  userId: number,
  ip: string | null,
  onCreated?: (id: number) => void,
): ServiceResult<{ id: number; docNo: string }> {
  const staffError = staffUsable(db, input.staffId, 'Packer');
  if (staffError) return { ok: false, code: 400, error: staffError };
  const source = packSourceInfo(db, office, input.lotType, input.lotId);
  if (!source) return { ok: false, code: 400, error: 'That source batch was not found.' };
  if (source.available < input.qtyPcs) {
    return {
      ok: false,
      code: 409,
      error: `${source.label} has only ${source.available} pcs available.`,
    };
  }
  if (input.kind === 'bundle' && !input.label) {
    return { ok: false, code: 400, error: 'Give the bundle a name so it can be found later.' };
  }

  let id = 0;
  let docNo = '';
  try {
    const tx = db.transaction(() => {
      docNo = nextDocNo(db, 'pack', office);
      // the packer's pay per dozen is snapshotted here, like contractor rates on jobs
      const rate = input.ratePaisePerDozen ?? staffDefaultRate(db, input.staffId);
      const info = db
        .prepare(
          `INSERT INTO pack_issues (doc_no, office_id, issue_date, staff_id, model_id, color_id, size_id,
            qty_pcs, kind, label, rate_paise_per_dozen, notes, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          docNo,
          office.id,
          input.issueDate,
          input.staffId,
          source.modelId,
          source.colorId,
          source.sizeId,
          input.qtyPcs,
          input.kind,
          input.label,
          rate,
          input.notes,
          userId,
        );
      id = Number(info.lastInsertRowid);

      // Allocations keep the FG→checker→contractor trace intact. A bundle source is a
      // pack_issue (not allowed in pack_allocations by the v1 CHECK), so its ORIGINAL
      // allocations are carried forward instead — the trace passes through the bundle.
      const insertAlloc = db.prepare(
        `INSERT INTO pack_allocations (pack_issue_id, packing_lot_type, packing_lot_id, qty_pcs)
         VALUES (?, ?, ?, ?)`,
      );
      if (input.lotType === 'pack_issue') {
        const bundleAllocs = db
          .prepare(
            `SELECT packing_lot_type, packing_lot_id, qty_pcs FROM pack_allocations
             WHERE pack_issue_id = ? ORDER BY id`,
          )
          .all(input.lotId) as Array<{ packing_lot_type: 'check_issue' | 'opening'; packing_lot_id: number; qty_pcs: number }>;
        const takes = splitFifo(
          bundleAllocs.map((a) => ({ lotType: a.packing_lot_type, lotId: a.packing_lot_id, qty: a.qty_pcs })),
          input.qtyPcs,
        );
        for (const take of takes) insertAlloc.run(id, take.lotType, take.lotId, take.qty);
      } else {
        insertAlloc.run(id, input.lotType, input.lotId, input.qtyPcs);
      }

      const base = {
        officeId: office.id,
        modelId: source.modelId,
        colorId: source.colorId,
        sizeId: source.sizeId,
      };
      postMovements(
        db,
        [
          {
            ...base,
            stage: 'PACKING',
            staffId: source.holderStaffId,
            lotType: input.lotType,
            lotId: input.lotId,
            qty: -input.qtyPcs,
            refType: 'pack_issue',
            refId: id,
          },
          {
            ...base,
            stage: 'PACKING',
            staffId: input.staffId,
            lotType: 'pack_issue',
            lotId: id,
            qty: input.qtyPcs,
            refType: 'pack_issue',
            refId: id,
          },
        ],
        userId,
      );
      audit(db, {
        userId,
        action: 'create',
        entityType: 'pack_issue',
        entityId: id,
        new: { docNo, officeId: office.id, ...input },
        ip,
      });
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
  office: Office,
  packIssueId: number,
  input: PackResultInput,
  userId: number,
  ip: string | null,
): ServiceResult<{ id: number; status: string }> {
  const issue = db
    .prepare('SELECT * FROM pack_issues WHERE id = ? AND office_id = ? AND voided_at IS NULL')
    .get(packIssueId, office.id) as Record<string, unknown> | undefined;
  if (!issue) return { ok: false, code: 404, error: 'Packing issue not found.' };
  if (issue.status === 'completed') {
    return { ok: false, code: 409, error: 'This packing issue is already completed.' };
  }

  // A bundle's pieces may have been moved to another packing — results only cover what
  // the holder still physically has.
  const held = (
    db
      .prepare(
        `SELECT COALESCE(SUM(qty),0) AS bal FROM stock_ledger
         WHERE stage='PACKING' AND lot_type='pack_issue' AND lot_id = ?`,
      )
      .get(packIssueId) as { bal: number }
  ).bal;
  const sessionTotal = input.qtyPacked + input.qtyShort;
  if (sessionTotal > held) {
    return {
      ok: false,
      code: 409,
      error: `This session covers ${sessionTotal} pcs but only ${held} pcs are with the packer.`,
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
      officeId: office.id,
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
        `INSERT INTO discrepancies (stage, office_id, ref_type, ref_id, qty_pcs, reason, note, created_by)
         VALUES ('PACKING', ?, 'pack_result', ?, ?, ?, ?, ?)`,
      ).run(office.id, resultId, -input.qtyShort, input.shortReason, input.notes, userId);
    }
    postMovements(db, movements, userId);

    if (sessionTotal === held) {
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
  office: Office,
  packIssueId: number,
  reason: string,
  userId: number,
  ip: string | null,
): ServiceResult {
  const issue = db
    .prepare('SELECT * FROM pack_issues WHERE id = ? AND office_id = ?')
    .get(packIssueId, office.id) as Record<string, unknown> | undefined;
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

  // What the issue drew from is in its own ledger rows — works for pool AND bundle sources.
  const consumed = db
    .prepare(
      `SELECT lot_type, lot_id, staff_id, -SUM(qty) AS qty FROM stock_ledger
       WHERE ref_type = 'pack_issue' AND ref_id = ? AND qty < 0
       GROUP BY lot_type, lot_id`,
    )
    .all(packIssueId) as Array<{ lot_type: string; lot_id: number; staff_id: number | null; qty: number }>;

  const base = {
    officeId: office.id,
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
        ...consumed.map((c) => ({
          ...base,
          stage: 'PACKING' as const,
          staffId: c.staff_id,
          lotType: c.lot_type as never,
          lotId: c.lot_id,
          qty: c.qty,
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

export function listPackIssues(
  db: Db,
  officeId: number,
  opts: { kind?: 'pack' | 'bundle' } = {},
): Array<Record<string, unknown>> {
  const where: string[] = ['pi.voided_at IS NULL', 'pi.office_id = ?'];
  const params: unknown[] = [officeId];
  if (opts.kind) {
    where.push('pi.kind = ?');
    params.push(opts.kind);
  }
  const issues = db
    .prepare(
      `SELECT pi.id, pi.doc_no AS docNo, pi.issue_date AS issueDate, pi.status, pi.notes,
              pi.qty_pcs AS qtyPcs, pi.kind, pi.label, pi.rate_paise_per_dozen AS ratePaisePerDozen,
              pi.voided_at AS voidedAt,
              pi.staff_id AS staffId, st.name AS staffName,
              pi.model_id AS modelId, m.code AS code, m.image_path AS codeImagePath,
              m.code || '-' || s.code AS sizeCodeLabel,
              pi.color_id AS colorId, c.name AS colorName,
              pi.size_id AS sizeId, s.code AS sizeCode
       FROM pack_issues pi
       JOIN staff st ON st.id = pi.staff_id
       JOIN models m ON m.id = pi.model_id
       JOIN colors c ON c.id = pi.color_id
       JOIN sizes s ON s.id = pi.size_id
       WHERE ${where.join(' AND ')}
       ORDER BY pi.id DESC`,
    )
    .all(...params) as Array<Record<string, unknown>>;
  const resultsStmt = db.prepare(
    `SELECT id, result_date AS resultDate, qty_packed AS qtyPacked, qty_short AS qtyShort,
            short_reason AS shortReason, notes
     FROM pack_results WHERE pack_issue_id = ? ORDER BY id`,
  );
  const heldStmt = db.prepare(
    `SELECT COALESCE(SUM(qty),0) AS bal FROM stock_ledger
     WHERE stage='PACKING' AND lot_type='pack_issue' AND lot_id = ?`,
  );
  for (const issue of issues) {
    const results = resultsStmt.all(issue.id) as Array<Record<string, unknown>>;
    issue.results = results;
    issue.packedPcs = results.reduce((s, r) => s + (r.qtyPacked as number), 0);
    issue.shortPcs = results.reduce((s, r) => s + (r.qtyShort as number), 0);
    issue.heldPcs = (heldStmt.get(issue.id) as { bal: number }).bal;
  }
  return issues;
}

// ---------------------------------------------------------------------------
// dispatch (minimal FG stock-out — the full sales module lives on the roadmap)
// ---------------------------------------------------------------------------

export function createDispatch(
  db: Db,
  office: Office,
  input: DispatchInput,
  userId: number,
  ip: string | null,
  onCreated?: (id: number) => void,
): ServiceResult<{ id: number; docNo: string }> {
  let id = 0;
  let docNo = '';
  try {
    const tx = db.transaction(() => {
      docNo = nextDocNo(db, 'dispatch', office);
      const info = db
        .prepare(
          `INSERT INTO fg_dispatches (doc_no, office_id, dispatch_date, model_id, color_id, size_id, qty_pcs, notes, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(docNo, office.id, input.dispatchDate, input.modelId, input.colorId, input.sizeId, input.qtyPcs, input.notes, userId);
      id = Number(info.lastInsertRowid);

      const lots = availableLots(db, {
        stage: 'FG',
        officeId: office.id,
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
          officeId: office.id,
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
      audit(db, { userId, action: 'create', entityType: 'fg_dispatch', entityId: id, new: { docNo, officeId: office.id, ...input }, ip });
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
  office: Office,
  id: number,
  reason: string,
  userId: number,
  ip: string | null,
): ServiceResult {
  const dispatch = db
    .prepare('SELECT * FROM fg_dispatches WHERE id = ? AND office_id = ?')
    .get(id, office.id) as Record<string, unknown> | undefined;
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
        officeId: office.id,
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

export function listDispatches(db: Db, officeId: number): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT d.id, d.doc_no AS docNo, d.dispatch_date AS dispatchDate, d.qty_pcs AS qtyPcs,
              d.notes, d.voided_at AS voidedAt,
              m.code AS modelCode, m.code || '-' || s.code AS sizeCodeLabel,
              c.name AS colorName, s.code AS sizeCode
       FROM fg_dispatches d
       JOIN models m ON m.id = d.model_id
       JOIN colors c ON c.id = d.color_id
       JOIN sizes s ON s.id = d.size_id
       WHERE d.office_id = ?
       ORDER BY d.id DESC`,
    )
    .all(officeId) as Array<Record<string, unknown>>;
}
