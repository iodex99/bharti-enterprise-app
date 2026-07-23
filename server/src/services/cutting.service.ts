import { clothRequiredCm, variancePct, type CuttingActualsInput, type CuttingPlanInput } from '@shared';
import type { Db } from '../db/connection';
import { nowIso } from '../db/connection';
import { audit } from './audit.service';
import { nextDocNo } from './docNo.service';
import { LedgerError, postMovements } from './ledger.service';
import { assertActive, type ServiceResult } from './purchases.service';

/**
 * Module 2/3: cutting consumes a specific RAW lot (explicit batch selection — the cutter
 * physically picks a roll) and, on completion, creates CUT stock per size line.
 * The MODEL is chosen HERE (cloth has none until it is cut), and consumption is
 * COMPUTED from per-size geometry: length per piece (inches) × strips needed given how
 * many pieces fit across the cloth width (shared clothRequiredCm).
 * Ledger flow: plan  = RAW −computed_cm (cutting_consume, terminal)
 *              actual = CUT +actual_pcs per line (cutting_output, genesis)
 */

type RawLotInfo = {
  colorId: number;
  available: number;
  label: string;
};

function rawLotInfo(db: Db, lotType: 'purchase' | 'opening', lotId: number): RawLotInfo | null {
  const bal = db
    .prepare(
      `SELECT COALESCE(SUM(qty),0) AS bal FROM stock_ledger
       WHERE stage='RAW' AND lot_type = ? AND lot_id = ?`,
    )
    .get(lotType, lotId) as { bal: number };
  if (lotType === 'purchase') {
    const p = db
      .prepare('SELECT color_id, doc_no FROM purchases WHERE id = ? AND voided_at IS NULL')
      .get(lotId) as { color_id: number; doc_no: string } | undefined;
    if (!p) return null;
    return { colorId: p.color_id, available: bal.bal, label: p.doc_no };
  }
  const o = db
    .prepare(
      `SELECT color_id, doc_no FROM opening_balances
       WHERE id = ? AND stage = 'RAW' AND voided_at IS NULL`,
    )
    .get(lotId) as { color_id: number; doc_no: string } | undefined;
  if (!o) return null;
  return { colorId: o.color_id, available: bal.bal, label: o.doc_no };
}

/** Total cloth a plan consumes, integer cm — server-computed, authoritative. */
export function planConsumptionCm(lines: CuttingPlanInput['lines']): number {
  return lines.reduce(
    (sum, l) => sum + clothRequiredCm(l.expectedPcs, l.clothPerPcInchC, l.widthCount),
    0,
  );
}

function validatePlanInputs(db: Db, input: CuttingPlanInput): string | null {
  const modelErr = assertActive(db, 'models', input.modelId, 'Model');
  if (modelErr) return modelErr;
  for (const line of input.lines) {
    const size = db
      .prepare('SELECT is_active FROM sizes WHERE id = ? AND deleted_at IS NULL')
      .get(line.sizeId) as { is_active: number } | undefined;
    if (!size) return 'Size not found.';
    if (!size.is_active) return 'A selected size is deactivated.';
  }
  return null;
}

export function createCuttingPlan(
  db: Db,
  input: CuttingPlanInput,
  userId: number,
  ip: string | null,
  onCreated?: (id: number) => void,
): ServiceResult<{ id: number; docNo: string }> {
  const lot = rawLotInfo(db, input.rawLotType, input.rawLotId);
  if (!lot) return { ok: false, code: 400, error: 'Raw material batch not found.' };
  const inputErr = validatePlanInputs(db, input);
  if (inputErr) return { ok: false, code: 400, error: inputErr };

  const consumeCm = planConsumptionCm(input.lines);
  if (consumeCm <= 0) return { ok: false, code: 400, error: 'The plan consumes no cloth.' };
  if (lot.available < consumeCm) {
    return {
      ok: false,
      code: 400,
      error: `This plan needs ${(consumeCm / 100).toFixed(2)} m but batch ${lot.label} has only ${(lot.available / 100).toFixed(2)} m available.`,
    };
  }

  let id = 0;
  let docNo = '';
  try {
    const tx = db.transaction(() => {
      docNo = nextDocNo(db, 'cutting');
      const info = db
        .prepare(
          `INSERT INTO cutting_batches (doc_no, cut_date, raw_lot_type, raw_lot_id, model_id,
            color_id, meters_used_cm, status, notes, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)`,
        )
        .run(
          docNo,
          input.cutDate,
          input.rawLotType,
          input.rawLotId,
          input.modelId,
          lot.colorId,
          consumeCm,
          input.notes,
          userId,
        );
      id = Number(info.lastInsertRowid);
      const insertLine = db.prepare(
        `INSERT INTO cutting_lines (cutting_batch_id, size_id, expected_pcs, cloth_per_pc_inch_c, width_count)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const line of input.lines) {
        insertLine.run(id, line.sizeId, line.expectedPcs, line.clothPerPcInchC, line.widthCount);
      }
      postMovements(
        db,
        [
          {
            stage: 'RAW',
            modelId: rawLotModelId(db, input.rawLotType, input.rawLotId),
            colorId: lot.colorId,
            sizeId: null,
            lotType: input.rawLotType,
            lotId: input.rawLotId,
            qty: -consumeCm,
            refType: 'cutting_consume',
            refId: id,
          },
        ],
        userId,
      );
      audit(db, { userId, action: 'create', entityType: 'cutting_batch', entityId: id, new: { docNo, consumeCm, ...input }, ip });
      onCreated?.(id);
    });
    tx();
  } catch (err) {
    if (err instanceof LedgerError) return { ok: false, code: 409, error: err.message };
    throw err;
  }
  return { ok: true, id, docNo };
}

/** RAW ledger rows must reuse the model the lot was booked under (sentinel or legacy). */
function rawLotModelId(db: Db, lotType: 'purchase' | 'opening', lotId: number): number {
  const table = lotType === 'purchase' ? 'purchases' : 'opening_balances';
  return (db.prepare(`SELECT model_id FROM ${table} WHERE id = ?`).get(lotId) as { model_id: number })
    .model_id;
}

/**
 * Re-plan a batch that has NOT been cut yet (status 'planned'): restore the old cloth,
 * validate + apply the new plan in one transaction. Doc number is kept.
 */
export function editCuttingPlan(
  db: Db,
  batchId: number,
  input: CuttingPlanInput,
  userId: number,
  ip: string | null,
): ServiceResult {
  const batch = db
    .prepare('SELECT * FROM cutting_batches WHERE id = ? AND voided_at IS NULL')
    .get(batchId) as Record<string, unknown> | undefined;
  if (!batch) return { ok: false, code: 404, error: 'Cutting batch not found.' };
  if (batch.status !== 'planned') {
    return { ok: false, code: 409, error: 'Actuals are recorded — this plan can no longer be edited.' };
  }
  const inputErr = validatePlanInputs(db, input);
  if (inputErr) return { ok: false, code: 400, error: inputErr };
  const newLot = rawLotInfo(db, input.rawLotType, input.rawLotId);
  if (!newLot) return { ok: false, code: 400, error: 'Raw material batch not found.' };
  const consumeCm = planConsumptionCm(input.lines);
  if (consumeCm <= 0) return { ok: false, code: 400, error: 'The plan consumes no cloth.' };

  const oldLines = db
    .prepare('SELECT size_id, expected_pcs, cloth_per_pc_inch_c, width_count FROM cutting_lines WHERE cutting_batch_id = ?')
    .all(batchId);

  try {
    const tx = db.transaction(() => {
      // 1) give the old cloth back (same pattern as void)
      postMovements(
        db,
        [
          {
            stage: 'RAW',
            modelId: rawLotModelId(db, batch.raw_lot_type as 'purchase' | 'opening', batch.raw_lot_id as number),
            colorId: batch.color_id as number,
            sizeId: null,
            lotType: batch.raw_lot_type as 'purchase' | 'opening',
            lotId: batch.raw_lot_id as number,
            qty: batch.meters_used_cm as number,
            refType: 'adjustment_in',
            refId: batchId,
          },
        ],
        userId,
      );
      // 2) availability check AFTER the restore (covers same-lot edits)
      const lotNow = rawLotInfo(db, input.rawLotType, input.rawLotId)!;
      if (lotNow.available < consumeCm) {
        throw new LedgerError(
          `This plan needs ${(consumeCm / 100).toFixed(2)} m but batch ${lotNow.label} has only ${(lotNow.available / 100).toFixed(2)} m available.`,
        );
      }
      // 3) replace the lines and the batch header (doc_no unchanged)
      db.prepare('DELETE FROM cutting_lines WHERE cutting_batch_id = ?').run(batchId);
      const insertLine = db.prepare(
        `INSERT INTO cutting_lines (cutting_batch_id, size_id, expected_pcs, cloth_per_pc_inch_c, width_count)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const line of input.lines) {
        insertLine.run(batchId, line.sizeId, line.expectedPcs, line.clothPerPcInchC, line.widthCount);
      }
      db.prepare(
        `UPDATE cutting_batches SET cut_date = ?, raw_lot_type = ?, raw_lot_id = ?, model_id = ?,
          color_id = ?, meters_used_cm = ?, notes = ? WHERE id = ?`,
      ).run(
        input.cutDate,
        input.rawLotType,
        input.rawLotId,
        input.modelId,
        lotNow.colorId,
        consumeCm,
        input.notes,
        batchId,
      );
      // 4) consume the new cloth
      postMovements(
        db,
        [
          {
            stage: 'RAW',
            modelId: rawLotModelId(db, input.rawLotType, input.rawLotId),
            colorId: lotNow.colorId,
            sizeId: null,
            lotType: input.rawLotType,
            lotId: input.rawLotId,
            qty: -consumeCm,
            refType: 'cutting_consume',
            refId: batchId,
          },
        ],
        userId,
      );
      audit(db, {
        userId,
        action: 'update',
        entityType: 'cutting_batch',
        entityId: batchId,
        old: { lines: oldLines, metersUsedCm: batch.meters_used_cm, modelId: batch.model_id, rawLotType: batch.raw_lot_type, rawLotId: batch.raw_lot_id },
        new: { consumeCm, ...input },
        ip,
      });
    });
    tx();
  } catch (err) {
    if (err instanceof LedgerError) return { ok: false, code: 409, error: err.message };
    throw err;
  }
  return { ok: true, id: batchId };
}

/** "Delete" for a not-yet-cut plan: a void with a standard reason (no hard deletes). */
export function deletePlannedBatch(
  db: Db,
  batchId: number,
  userId: number,
  ip: string | null,
): ServiceResult {
  const batch = db
    .prepare('SELECT status, voided_at FROM cutting_batches WHERE id = ?')
    .get(batchId) as { status: string; voided_at: string | null } | undefined;
  if (!batch) return { ok: false, code: 404, error: 'Cutting batch not found.' };
  if (batch.voided_at) return { ok: false, code: 409, error: 'Already deleted.' };
  if (batch.status !== 'planned') {
    return { ok: false, code: 409, error: 'Actuals are recorded — only the Admin can void this batch.' };
  }
  return voidCuttingBatch(db, batchId, 'plan deleted before cutting', userId, ip);
}

export function recordActuals(
  db: Db,
  batchId: number,
  input: CuttingActualsInput,
  userId: number,
  ip: string | null,
): ServiceResult {
  const batch = db
    .prepare('SELECT * FROM cutting_batches WHERE id = ? AND voided_at IS NULL')
    .get(batchId) as Record<string, unknown> | undefined;
  if (!batch) return { ok: false, code: 404, error: 'Cutting batch not found.' };
  if (batch.status === 'completed') {
    return { ok: false, code: 409, error: 'Actuals are already recorded for this batch.' };
  }

  const planned = db
    .prepare('SELECT id, size_id, expected_pcs FROM cutting_lines WHERE cutting_batch_id = ?')
    .all(batchId) as Array<{ id: number; size_id: number; expected_pcs: number }>;
  const plannedBySize = new Map(planned.map((l) => [l.size_id, l]));
  const inputBySize = new Map(input.lines.map((l) => [l.sizeId, l]));

  // every planned size needs an actual (0 allowed); extra sizes are unplanned yield
  for (const line of planned) {
    if (!inputBySize.has(line.size_id)) {
      return { ok: false, code: 400, error: 'Enter an actual quantity for every planned size (0 is allowed).' };
    }
  }
  // variance requires a reason
  for (const line of input.lines) {
    const expected = plannedBySize.get(line.sizeId)?.expected_pcs ?? 0;
    if (line.actualPcs !== expected && !line.varianceReason) {
      return {
        ok: false,
        code: 400,
        error: 'Every size with a difference between expected and actual needs a reason.',
      };
    }
  }

  const tx = db.transaction(() => {
    const movements = [];
    for (const line of input.lines) {
      const plannedLine = plannedBySize.get(line.sizeId);
      let lineId: number;
      if (plannedLine) {
        db.prepare(
          `UPDATE cutting_lines SET actual_pcs = ?, variance_reason = ?, reason_note = ? WHERE id = ?`,
        ).run(line.actualPcs, line.varianceReason ?? null, line.reasonNote, plannedLine.id);
        lineId = plannedLine.id;
      } else {
        const info = db
          .prepare(
            `INSERT INTO cutting_lines (cutting_batch_id, size_id, expected_pcs, actual_pcs, variance_reason, reason_note)
             VALUES (?, ?, 0, ?, ?, ?)`,
          )
          .run(batchId, line.sizeId, line.actualPcs, line.varianceReason ?? null, line.reasonNote);
        lineId = Number(info.lastInsertRowid);
      }
      const expected = plannedLine?.expected_pcs ?? 0;
      if (line.actualPcs !== expected) {
        db.prepare(
          `INSERT INTO discrepancies (stage, ref_type, ref_id, qty_pcs, reason, note, created_by)
           VALUES ('CUT', 'cutting_line', ?, ?, ?, ?, ?)`,
        ).run(lineId, line.actualPcs - expected, line.varianceReason, line.reasonNote, userId);
      }
      if (line.actualPcs > 0) {
        movements.push({
          stage: 'CUT' as const,
          modelId: batch.model_id as number,
          colorId: batch.color_id as number,
          sizeId: line.sizeId,
          lotType: 'cutting_line' as const,
          lotId: lineId,
          qty: line.actualPcs,
          refType: 'cutting_output' as const,
          refId: batchId,
        });
      }
    }
    if (movements.length > 0) postMovements(db, movements, userId);
    db.prepare(`UPDATE cutting_batches SET status = 'completed', completed_at = ? WHERE id = ?`).run(
      nowIso(),
      batchId,
    );
    audit(db, {
      userId,
      action: 'record_actuals',
      entityType: 'cutting_batch',
      entityId: batchId,
      new: input,
      ip,
    });
  });
  tx();
  return { ok: true, id: batchId };
}

export function voidCuttingBatch(
  db: Db,
  batchId: number,
  reason: string,
  userId: number,
  ip: string | null,
): ServiceResult {
  const batch = db
    .prepare('SELECT * FROM cutting_batches WHERE id = ?')
    .get(batchId) as Record<string, unknown> | undefined;
  if (!batch) return { ok: false, code: 404, error: 'Cutting batch not found.' };
  if (batch.voided_at) return { ok: false, code: 409, error: 'Already voided.' };

  const lines = db
    .prepare('SELECT id, actual_pcs FROM cutting_lines WHERE cutting_batch_id = ?')
    .all(batchId) as Array<{ id: number; actual_pcs: number | null }>;

  // CUT lots produced by this batch must be fully unconsumed
  for (const line of lines) {
    if (!line.actual_pcs) continue;
    const { bal } = db
      .prepare(
        `SELECT COALESCE(SUM(qty),0) AS bal FROM stock_ledger
         WHERE stage='CUT' AND lot_type='cutting_line' AND lot_id = ?`,
      )
      .get(line.id) as { bal: number };
    if (bal !== line.actual_pcs) {
      return {
        ok: false,
        code: 409,
        error: `Cannot void ${batch.doc_no as string}: cut pieces were already issued to a contractor. Void the downstream document first.`,
      };
    }
  }

  const tx = db.transaction(() => {
    const movements = [];
    // remove CUT outputs (if completed)
    for (const line of lines) {
      if (!line.actual_pcs) continue;
      movements.push({
        stage: 'CUT' as const,
        modelId: batch.model_id as number,
        colorId: batch.color_id as number,
        sizeId: (
          db.prepare('SELECT size_id FROM cutting_lines WHERE id = ?').get(line.id) as {
            size_id: number;
          }
        ).size_id,
        lotType: 'cutting_line' as const,
        lotId: line.id,
        qty: -line.actual_pcs,
        refType: 'adjustment_out' as const,
        refId: batchId,
      });
    }
    // restore the RAW meters — under the model the LOT is booked as (sentinel/legacy),
    // which may differ from the batch's model now that the model is chosen at cutting
    movements.push({
      stage: 'RAW' as const,
      modelId: rawLotModelId(db, batch.raw_lot_type as 'purchase' | 'opening', batch.raw_lot_id as number),
      colorId: batch.color_id as number,
      sizeId: null,
      lotType: batch.raw_lot_type as 'purchase' | 'opening',
      lotId: batch.raw_lot_id as number,
      qty: batch.meters_used_cm as number,
      refType: 'adjustment_in' as const,
      refId: batchId,
    });
    postMovements(db, movements, userId);
    db.prepare(
      'UPDATE cutting_batches SET voided_at = ?, void_reason = ?, voided_by = ? WHERE id = ?',
    ).run(nowIso(), reason, userId, batchId);
    audit(db, { userId, action: 'void', entityType: 'cutting_batch', entityId: batchId, new: { reason }, ip });
  });
  tx();
  return { ok: true, id: batchId };
}

export function listCuttingBatches(
  db: Db,
  opts: { status?: string; includeVoided?: boolean } = {},
): Array<Record<string, unknown>> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!opts.includeVoided) where.push('cb.voided_at IS NULL');
  if (opts.status) {
    where.push('cb.status = ?');
    params.push(opts.status);
  }
  const batches = db
    .prepare(
      `SELECT cb.id, cb.doc_no AS docNo, cb.cut_date AS cutDate, cb.status,
              cb.raw_lot_type AS rawLotType, cb.raw_lot_id AS rawLotId,
              cb.meters_used_cm AS metersUsedCm, cb.notes, cb.voided_at AS voidedAt,
              cb.model_id AS modelId, m.code AS modelCode, m.name AS modelName,
              cb.color_id AS colorId, c.name AS colorName,
              COALESCE(p.doc_no, o.doc_no) AS rawDocNo
       FROM cutting_batches cb
       JOIN models m ON m.id = cb.model_id
       JOIN colors c ON c.id = cb.color_id
       LEFT JOIN purchases p ON cb.raw_lot_type = 'purchase' AND p.id = cb.raw_lot_id
       LEFT JOIN opening_balances o ON cb.raw_lot_type = 'opening' AND o.id = cb.raw_lot_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY cb.id DESC`,
    )
    .all(...params) as Array<Record<string, unknown>>;

  const lineStmt = db.prepare(
    `SELECT cl.id, cl.size_id AS sizeId, s.code AS sizeCode, cl.expected_pcs AS expectedPcs,
            cl.actual_pcs AS actualPcs, cl.variance_reason AS varianceReason, cl.reason_note AS reasonNote,
            cl.cloth_per_pc_inch_c AS clothPerPcInchC, cl.width_count AS widthCount
     FROM cutting_lines cl JOIN sizes s ON s.id = cl.size_id
     WHERE cl.cutting_batch_id = ? ORDER BY s.sort_order, s.code`,
  );
  for (const b of batches) {
    const lines = lineStmt.all(b.id) as Array<Record<string, unknown>>;
    b.lines = lines;
    const expected = lines.reduce((s, l) => s + (l.expectedPcs as number), 0);
    const hasActuals = b.status === 'completed';
    const actual = lines.reduce((s, l) => s + ((l.actualPcs as number | null) ?? 0), 0);
    b.expectedTotalPcs = expected;
    b.actualTotalPcs = hasActuals ? actual : null;
    b.variancePct = hasActuals ? variancePct(expected, actual) : null;
  }
  return batches;
}
