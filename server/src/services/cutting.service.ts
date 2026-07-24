import { clothRequiredInchC, formatLen, type CuttingPlanInput } from '@shared';
import type { Db } from '../db/connection';
import { nowIso } from '../db/connection';
import { audit } from './audit.service';
import { nextDocNo } from './docNo.service';
import { LedgerError, postMovements, type Movement } from './ledger.service';
import type { Office } from './offices.service';
import { modelIdForCode } from './products.service';
import { type ServiceResult } from './purchases.service';

/**
 * Module 2: cutting (v2, ADR-030/031).
 * The plan IS the cutting — there is no separate "record actuals" step. Creating a
 * batch consumes the chosen RAW lot (computed from per-size geometry) AND creates the
 * CUT stock in the same transaction. Each size line carries the CODE typed on it — the
 * product identity "CODE-SIZE" is born here (with its photo) and used everywhere after.
 *
 * A batch can be EDITED or DELETED for as long as none of its cut pieces have moved
 * downstream; both restore the cloth atomically and edits keep the document number.
 *
 * Ledger: RAW −consumed (cutting_consume) ; CUT +qtyPcs per line (cutting_output).
 */

type RawLotInfo = {
  colorId: number;
  available: number;
  widthInchC: number | null;
  label: string;
};

function rawLotInfo(
  db: Db,
  office: Office,
  lotType: 'purchase' | 'opening',
  lotId: number,
): RawLotInfo | null {
  const bal = db
    .prepare(
      `SELECT COALESCE(SUM(qty),0) AS bal FROM stock_ledger
       WHERE stage='RAW' AND lot_type = ? AND lot_id = ?`,
    )
    .get(lotType, lotId) as { bal: number };
  if (lotType === 'purchase') {
    const p = db
      .prepare(
        `SELECT color_id, doc_no, width_inch_c FROM purchases
         WHERE id = ? AND office_id = ? AND voided_at IS NULL`,
      )
      .get(lotId, office.id) as
      | { color_id: number; doc_no: string; width_inch_c: number | null }
      | undefined;
    if (!p) return null;
    return { colorId: p.color_id, available: bal.bal, widthInchC: p.width_inch_c, label: p.doc_no };
  }
  const o = db
    .prepare(
      `SELECT color_id, doc_no, width_inch_c FROM opening_balances
       WHERE id = ? AND office_id = ? AND stage = 'RAW' AND voided_at IS NULL`,
    )
    .get(lotId, office.id) as
    | { color_id: number; doc_no: string; width_inch_c: number | null }
    | undefined;
  if (!o) return null;
  return { colorId: o.color_id, available: bal.bal, widthInchC: o.width_inch_c, label: o.doc_no };
}

/** Total cloth a plan consumes, integer hundredths of an inch — server-computed. */
export function planConsumptionInchC(lines: CuttingPlanInput['lines']): number {
  return lines.reduce(
    (sum, l) => sum + clothRequiredInchC(l.qtyPcs, l.clothPerPcInchC, l.widthCount),
    0,
  );
}

/** Legacy NOT NULL column — approximate cm, never read. */
function legacyCm(inchC: number): number {
  return Math.max(1, Math.round((inchC * 254) / 10000));
}

function validatePlanSizes(db: Db, input: CuttingPlanInput): string | null {
  for (const line of input.lines) {
    const size = db
      .prepare('SELECT is_active FROM sizes WHERE id = ? AND deleted_at IS NULL')
      .get(line.sizeId) as { is_active: number } | undefined;
    if (!size) return 'Size not found.';
    if (!size.is_active) return 'A selected size is deactivated.';
  }
  return null;
}

/** RAW ledger rows must reuse the model the lot was booked under (the RAW-CLOTH sentinel). */
function rawLotModelId(db: Db, lotType: 'purchase' | 'opening', lotId: number): number {
  const table = lotType === 'purchase' ? 'purchases' : 'opening_balances';
  return (db.prepare(`SELECT model_id FROM ${table} WHERE id = ?`).get(lotId) as { model_id: number })
    .model_id;
}

/** Insert the lines + their ledger movements for a batch. Runs inside the caller's tx. */
function applyPlanLines(
  db: Db,
  office: Office,
  batchId: number,
  colorId: number,
  input: CuttingPlanInput,
  userId: number,
): void {
  const insertLine = db.prepare(
    `INSERT INTO cutting_lines (cutting_batch_id, size_id, model_id, expected_pcs, actual_pcs,
       cloth_per_pc_inch_c, width_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const movements: Movement[] = [];
  for (const line of input.lines) {
    const modelId = modelIdForCode(db, line.code, userId, line.imagePath);
    const info = insertLine.run(
      batchId,
      line.sizeId,
      modelId,
      line.qtyPcs,
      line.qtyPcs, // the plan is final — what is planned is what is cut
      line.clothPerPcInchC,
      line.widthCount,
    );
    const lineId = Number(info.lastInsertRowid);
    movements.push({
      stage: 'CUT',
      officeId: office.id,
      modelId,
      colorId,
      sizeId: line.sizeId,
      lotType: 'cutting_line',
      lotId: lineId,
      qty: line.qtyPcs,
      refType: 'cutting_output',
      refId: batchId,
    });
  }
  postMovements(db, movements, userId);
}

export function createCuttingPlan(
  db: Db,
  office: Office,
  input: CuttingPlanInput,
  userId: number,
  ip: string | null,
  onCreated?: (id: number) => void,
): ServiceResult<{ id: number; docNo: string }> {
  const lot = rawLotInfo(db, office, input.rawLotType, input.rawLotId);
  if (!lot) return { ok: false, code: 400, error: 'Cloth batch not found in this office.' };
  const sizeErr = validatePlanSizes(db, input);
  if (sizeErr) return { ok: false, code: 400, error: sizeErr };

  const consumed = planConsumptionInchC(input.lines);
  if (consumed <= 0) return { ok: false, code: 400, error: 'The plan consumes no cloth.' };
  if (lot.available < consumed) {
    return {
      ok: false,
      code: 400,
      error: `This cutting needs ${formatLen(consumed)} but batch ${lot.label} has only ${formatLen(lot.available)} left.`,
    };
  }

  let id = 0;
  let docNo = '';
  try {
    const tx = db.transaction(() => {
      docNo = nextDocNo(db, 'cutting', office);
      // header model_id (legacy NOT NULL) carries the first line's model
      const firstModelId = modelIdForCode(db, input.lines[0]!.code, userId, input.lines[0]!.imagePath);
      const info = db
        .prepare(
          `INSERT INTO cutting_batches (doc_no, office_id, cut_date, raw_lot_type, raw_lot_id,
            model_id, color_id, meters_used_cm, consumed_inch_c, status, completed_at, notes, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)`,
        )
        .run(
          docNo,
          office.id,
          input.cutDate,
          input.rawLotType,
          input.rawLotId,
          firstModelId,
          lot.colorId,
          legacyCm(consumed),
          consumed,
          nowIso(),
          input.notes,
          userId,
        );
      id = Number(info.lastInsertRowid);

      postMovements(
        db,
        [
          {
            stage: 'RAW',
            officeId: office.id,
            modelId: rawLotModelId(db, input.rawLotType, input.rawLotId),
            colorId: lot.colorId,
            sizeId: null,
            lotType: input.rawLotType,
            lotId: input.rawLotId,
            qty: -consumed,
            refType: 'cutting_consume',
            refId: id,
          },
        ],
        userId,
      );
      applyPlanLines(db, office, id, lot.colorId, input, userId);
      audit(db, {
        userId,
        action: 'create',
        entityType: 'cutting_batch',
        entityId: id,
        new: { docNo, officeId: office.id, consumedInchC: consumed, ...input },
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

/**
 * Downstream guard shared by edit/delete/void: every CUT lot this batch produced must
 * still be fully unconsumed (nothing issued to a contractor from it).
 */
function downstreamBlock(db: Db, batchId: number, docNo: string): string | null {
  const lines = db
    .prepare('SELECT id, actual_pcs FROM cutting_lines WHERE cutting_batch_id = ?')
    .all(batchId) as Array<{ id: number; actual_pcs: number | null }>;
  for (const line of lines) {
    if (!line.actual_pcs) continue;
    const { bal } = db
      .prepare(
        `SELECT COALESCE(SUM(qty),0) AS bal FROM stock_ledger
         WHERE stage='CUT' AND lot_type='cutting_line' AND lot_id = ?`,
      )
      .get(line.id) as { bal: number };
    if (bal !== line.actual_pcs) {
      return `Cannot change ${docNo}: cut pieces were already issued to a contractor. Void the downstream document first.`;
    }
  }
  return null;
}

/** Reverse a batch's ledger effect (restore RAW, remove CUT). Runs inside the caller's tx. */
function reverseBatch(db: Db, office: Office, batch: Record<string, unknown>, userId: number): void {
  const lines = db
    .prepare('SELECT id, size_id, model_id, actual_pcs FROM cutting_lines WHERE cutting_batch_id = ?')
    .all(batch.id as number) as Array<{
    id: number;
    size_id: number;
    model_id: number;
    actual_pcs: number | null;
  }>;
  const movements: Movement[] = [];
  for (const line of lines) {
    if (!line.actual_pcs) continue;
    movements.push({
      stage: 'CUT',
      officeId: office.id,
      modelId: line.model_id,
      colorId: batch.color_id as number,
      sizeId: line.size_id,
      lotType: 'cutting_line',
      lotId: line.id,
      qty: -line.actual_pcs,
      refType: 'adjustment_out',
      refId: batch.id as number,
    });
  }
  movements.push({
    stage: 'RAW',
    officeId: office.id,
    modelId: rawLotModelId(db, batch.raw_lot_type as 'purchase' | 'opening', batch.raw_lot_id as number),
    colorId: batch.color_id as number,
    sizeId: null,
    lotType: batch.raw_lot_type as 'purchase' | 'opening',
    lotId: batch.raw_lot_id as number,
    qty: (batch.consumed_inch_c as number | null) ?? (batch.meters_used_cm as number),
    refType: 'adjustment_in',
    refId: batch.id as number,
  });
  postMovements(db, movements, userId);
}

/**
 * Edit a batch — any batch whose pieces have not moved downstream. Restores the old
 * cloth + pieces, applies the new plan, keeps the document number. Atomic.
 */
export function editCuttingPlan(
  db: Db,
  office: Office,
  batchId: number,
  input: CuttingPlanInput,
  userId: number,
  ip: string | null,
): ServiceResult {
  const batch = db
    .prepare('SELECT * FROM cutting_batches WHERE id = ? AND office_id = ? AND voided_at IS NULL')
    .get(batchId, office.id) as Record<string, unknown> | undefined;
  if (!batch) return { ok: false, code: 404, error: 'Cutting batch not found.' };
  const blocked = downstreamBlock(db, batchId, batch.doc_no as string);
  if (blocked) return { ok: false, code: 409, error: blocked };
  const sizeErr = validatePlanSizes(db, input);
  if (sizeErr) return { ok: false, code: 400, error: sizeErr };
  const newLot = rawLotInfo(db, office, input.rawLotType, input.rawLotId);
  if (!newLot) return { ok: false, code: 400, error: 'Cloth batch not found in this office.' };
  const consumed = planConsumptionInchC(input.lines);
  if (consumed <= 0) return { ok: false, code: 400, error: 'The plan consumes no cloth.' };

  const oldLines = db
    .prepare(
      'SELECT size_id, model_id, expected_pcs, cloth_per_pc_inch_c, width_count FROM cutting_lines WHERE cutting_batch_id = ?',
    )
    .all(batchId);

  try {
    const tx = db.transaction(() => {
      // 1) undo the current batch (cloth back, cut pieces removed)
      reverseBatch(db, office, batch, userId);
      // 2) availability AFTER the restore (covers same-lot edits)
      const lotNow = rawLotInfo(db, office, input.rawLotType, input.rawLotId)!;
      if (lotNow.available < consumed) {
        throw new LedgerError(
          `This cutting needs ${formatLen(consumed)} but batch ${lotNow.label} has only ${formatLen(lotNow.available)} left.`,
        );
      }
      // 3) replace lines + header (doc_no unchanged)
      db.prepare('DELETE FROM cutting_lines WHERE cutting_batch_id = ?').run(batchId);
      const firstModelId = modelIdForCode(db, input.lines[0]!.code, userId, input.lines[0]!.imagePath);
      db.prepare(
        `UPDATE cutting_batches SET cut_date = ?, raw_lot_type = ?, raw_lot_id = ?, model_id = ?,
          color_id = ?, meters_used_cm = ?, consumed_inch_c = ?, notes = ? WHERE id = ?`,
      ).run(
        input.cutDate,
        input.rawLotType,
        input.rawLotId,
        firstModelId,
        lotNow.colorId,
        legacyCm(consumed),
        consumed,
        input.notes,
        batchId,
      );
      // 4) consume the new cloth + create the new pieces
      postMovements(
        db,
        [
          {
            stage: 'RAW',
            officeId: office.id,
            modelId: rawLotModelId(db, input.rawLotType, input.rawLotId),
            colorId: lotNow.colorId,
            sizeId: null,
            lotType: input.rawLotType,
            lotId: input.rawLotId,
            qty: -consumed,
            refType: 'cutting_consume',
            refId: batchId,
          },
        ],
        userId,
      );
      applyPlanLines(db, office, batchId, lotNow.colorId, input, userId);
      audit(db, {
        userId,
        action: 'update',
        entityType: 'cutting_batch',
        entityId: batchId,
        old: { lines: oldLines, consumedInchC: batch.consumed_inch_c, rawLotType: batch.raw_lot_type, rawLotId: batch.raw_lot_id },
        new: { consumedInchC: consumed, ...input },
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

/** Delete = void with a standard reason. Same downstream guard as edit. */
export function deleteCuttingBatch(
  db: Db,
  office: Office,
  batchId: number,
  userId: number,
  ip: string | null,
): ServiceResult {
  return voidCuttingBatch(db, office, batchId, 'cutting entry deleted', userId, ip);
}

export function voidCuttingBatch(
  db: Db,
  office: Office,
  batchId: number,
  reason: string,
  userId: number,
  ip: string | null,
): ServiceResult {
  const batch = db
    .prepare('SELECT * FROM cutting_batches WHERE id = ? AND office_id = ?')
    .get(batchId, office.id) as Record<string, unknown> | undefined;
  if (!batch) return { ok: false, code: 404, error: 'Cutting batch not found.' };
  if (batch.voided_at) return { ok: false, code: 409, error: 'Already deleted.' };
  const blocked = downstreamBlock(db, batchId, batch.doc_no as string);
  if (blocked) return { ok: false, code: 409, error: blocked };

  const tx = db.transaction(() => {
    reverseBatch(db, office, batch, userId);
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
  officeId: number,
  opts: { includeVoided?: boolean } = {},
): Array<Record<string, unknown>> {
  const where: string[] = ['cb.office_id = ?'];
  const params: unknown[] = [officeId];
  if (!opts.includeVoided) where.push('cb.voided_at IS NULL');
  const batches = db
    .prepare(
      `SELECT cb.id, cb.doc_no AS docNo, cb.cut_date AS cutDate, cb.status,
              cb.raw_lot_type AS rawLotType, cb.raw_lot_id AS rawLotId,
              COALESCE(cb.consumed_inch_c, cb.meters_used_cm) AS consumedInchC,
              cb.notes, cb.voided_at AS voidedAt,
              cb.color_id AS colorId, c.name AS colorName,
              COALESCE(p.doc_no, o.doc_no) AS rawDocNo
       FROM cutting_batches cb
       JOIN colors c ON c.id = cb.color_id
       LEFT JOIN purchases p ON cb.raw_lot_type = 'purchase' AND p.id = cb.raw_lot_id
       LEFT JOIN opening_balances o ON cb.raw_lot_type = 'opening' AND o.id = cb.raw_lot_id
       WHERE ${where.join(' AND ')}
       ORDER BY cb.id DESC`,
    )
    .all(...params) as Array<Record<string, unknown>>;

  const lineStmt = db.prepare(
    `SELECT cl.id, cl.size_id AS sizeId, s.code AS sizeCode,
            cl.model_id AS modelId, m.code AS code, m.image_path AS imagePath,
            cl.expected_pcs AS qtyPcs,
            cl.cloth_per_pc_inch_c AS clothPerPcInchC, cl.width_count AS widthCount,
            (SELECT COALESCE(SUM(l.qty),0) FROM stock_ledger l
             WHERE l.stage='CUT' AND l.lot_type='cutting_line' AND l.lot_id = cl.id) AS remainingPcs
     FROM cutting_lines cl
     JOIN sizes s ON s.id = cl.size_id
     LEFT JOIN models m ON m.id = cl.model_id
     WHERE cl.cutting_batch_id = ? ORDER BY s.sort_order, s.code`,
  );
  for (const b of batches) {
    const lines = lineStmt.all(b.id) as Array<Record<string, unknown>>;
    for (const l of lines) {
      // the identity the business reads out loud: "315-L"
      l.sizeCodeLabel = `${(l.code as string | null) ?? '?'}-${l.sizeCode as string}`;
    }
    b.lines = lines;
    b.totalPcs = lines.reduce((s, l) => s + (l.qtyPcs as number), 0);
    // pieces from this batch already gone downstream? (drives the Edit/Delete buttons)
    b.editable =
      !b.voidedAt &&
      lines.every((l) => (l.remainingPcs as number) === (l.qtyPcs as number));
  }
  return batches;
}
