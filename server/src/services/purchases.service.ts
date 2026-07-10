import type { PurchaseEditInput, PurchaseInput } from '@shared';
import type { Db } from '../db/connection';
import { nowIso } from '../db/connection';
import { audit } from './audit.service';
import { nextDocNo } from './docNo.service';
import { LedgerError, postMovements } from './ledger.service';

/** total = meters × rate; qty_cm/100 gives meters. Server-computed, authoritative. */
export function purchaseTotalPaise(qtyCm: number, ratePaisePerMeter: number): number {
  return Math.round((qtyCm * ratePaisePerMeter) / 100);
}

export type ServiceResult<T = { id: number }> =
  | ({ ok: true } & T)
  | { ok: false; code: number; error: string };

function assertActive(db: Db, table: string, id: number, label: string): string | null {
  const row = db
    .prepare(`SELECT is_active FROM ${table} WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as { is_active: number } | undefined;
  if (!row) return `${label} not found.`;
  if (!row.is_active) return `${label} is deactivated — reactivate it or pick another.`;
  return null;
}

export function createPurchase(
  db: Db,
  input: PurchaseInput,
  userId: number,
  ip: string | null,
  onCreated?: (id: number) => void,
): ServiceResult<{ id: number; docNo: string }> {
  for (const [table, id, label] of [
    ['vendors', input.vendorId, 'Vendor'],
    ['models', input.modelId, 'Model'],
    ['colors', input.colorId, 'Color'],
  ] as const) {
    const err = assertActive(db, table, id, label);
    if (err) return { ok: false, code: 400, error: err };
  }

  let id = 0;
  let docNo = '';
  const tx = db.transaction(() => {
    docNo = nextDocNo(db, 'purchase');
    const info = db
      .prepare(
        `INSERT INTO purchases (doc_no, purchase_date, received_date, vendor_id, model_id,
          color_id, qty_cm, rate_paise_per_meter, total_paise, image_path, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        docNo,
        input.purchaseDate,
        input.receivedDate,
        input.vendorId,
        input.modelId,
        input.colorId,
        input.qtyCm,
        input.ratePaisePerMeter,
        purchaseTotalPaise(input.qtyCm, input.ratePaisePerMeter),
        input.imagePath ?? null,
        input.notes,
        userId,
      );
    id = Number(info.lastInsertRowid);
    postMovements(
      db,
      [
        {
          stage: 'RAW',
          modelId: input.modelId,
          colorId: input.colorId,
          sizeId: null,
          lotType: 'purchase',
          lotId: id,
          qty: input.qtyCm,
          refType: 'purchase',
          refId: id,
        },
      ],
      userId,
    );
    audit(db, {
      userId,
      action: 'create',
      entityType: 'purchase',
      entityId: id,
      new: { docNo, ...input },
      ip,
    });
    onCreated?.(id);
  });
  tx();
  return { ok: true, id, docNo };
}

export function editPurchase(
  db: Db,
  id: number,
  input: PurchaseEditInput,
  userId: number,
  ip: string | null,
): ServiceResult {
  const existing = db
    .prepare('SELECT * FROM purchases WHERE id = ? AND voided_at IS NULL')
    .get(id) as Record<string, unknown> | undefined;
  if (!existing) return { ok: false, code: 404, error: 'Purchase not found.' };

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE purchases SET rate_paise_per_meter = ?, total_paise = ?, image_path = ?, notes = ?
       WHERE id = ?`,
    ).run(
      input.ratePaisePerMeter,
      purchaseTotalPaise(existing.qty_cm as number, input.ratePaisePerMeter),
      input.imagePath ?? null,
      input.notes,
      id,
    );
    audit(db, {
      userId,
      action: 'update',
      entityType: 'purchase',
      entityId: id,
      old: {
        ratePaisePerMeter: existing.rate_paise_per_meter,
        imagePath: existing.image_path,
        notes: existing.notes,
      },
      new: input,
      ip,
    });
  });
  tx();
  return { ok: true, id };
}

export function voidPurchase(
  db: Db,
  id: number,
  reason: string,
  userId: number,
  ip: string | null,
): ServiceResult {
  const existing = db
    .prepare('SELECT * FROM purchases WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;
  if (!existing) return { ok: false, code: 404, error: 'Purchase not found.' };
  if (existing.voided_at) return { ok: false, code: 409, error: 'Purchase is already voided.' };

  // Downstream consumption blocks the void: the RAW lot must still be untouched.
  const { bal } = db
    .prepare(
      `SELECT COALESCE(SUM(qty), 0) AS bal FROM stock_ledger
       WHERE stage = 'RAW' AND lot_type = 'purchase' AND lot_id = ?`,
    )
    .get(id) as { bal: number };
  if (bal !== (existing.qty_cm as number)) {
    const consumer = db
      .prepare(
        `SELECT cb.doc_no FROM cutting_batches cb WHERE cb.purchase_id = ? AND cb.voided_at IS NULL
         ORDER BY cb.id LIMIT 1`,
      )
      .get(id) as { doc_no: string } | undefined;
    return {
      ok: false,
      code: 409,
      error: `Cannot void ${existing.doc_no as string}: cloth already used${
        consumer ? ` by cutting batch ${consumer.doc_no}` : ''
      }. Void the downstream document first.`,
    };
  }

  try {
    const tx = db.transaction(() => {
      postMovements(
        db,
        [
          {
            stage: 'RAW',
            modelId: existing.model_id as number,
            colorId: existing.color_id as number,
            sizeId: null,
            lotType: 'purchase',
            lotId: id,
            qty: -(existing.qty_cm as number),
            refType: 'adjustment_out',
            refId: id,
          },
        ],
        userId,
      );
      db.prepare(
        'UPDATE purchases SET voided_at = ?, void_reason = ?, voided_by = ? WHERE id = ?',
      ).run(nowIso(), reason, userId, id);
      audit(db, {
        userId,
        action: 'void',
        entityType: 'purchase',
        entityId: id,
        old: { docNo: existing.doc_no },
        new: { reason },
        ip,
      });
    });
    tx();
  } catch (err) {
    if (err instanceof LedgerError) return { ok: false, code: 409, error: err.message };
    throw err;
  }
  return { ok: true, id };
}

export type PurchaseListFilters = {
  vendorId?: number;
  modelId?: number;
  colorId?: number;
  from?: string;
  to?: string;
  includeVoided?: boolean;
};

export function listPurchases(db: Db, f: PurchaseListFilters): Array<Record<string, unknown>> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!f.includeVoided) where.push('p.voided_at IS NULL');
  if (f.vendorId) {
    where.push('p.vendor_id = ?');
    params.push(f.vendorId);
  }
  if (f.modelId) {
    where.push('p.model_id = ?');
    params.push(f.modelId);
  }
  if (f.colorId) {
    where.push('p.color_id = ?');
    params.push(f.colorId);
  }
  if (f.from) {
    where.push('p.purchase_date >= ?');
    params.push(f.from);
  }
  if (f.to) {
    where.push('p.purchase_date <= ?');
    params.push(f.to);
  }
  return db
    .prepare(
      `SELECT p.id, p.doc_no AS docNo, p.purchase_date AS purchaseDate,
              p.received_date AS receivedDate,
              p.vendor_id AS vendorId, v.name AS vendorName,
              p.model_id AS modelId, m.code AS modelCode, m.name AS modelName,
              p.color_id AS colorId, c.name AS colorName,
              p.qty_cm AS qtyCm, p.rate_paise_per_meter AS ratePaisePerMeter,
              p.total_paise AS totalPaise, p.image_path AS imagePath, p.notes,
              p.voided_at AS voidedAt, p.void_reason AS voidReason,
              (SELECT COALESCE(SUM(l.qty), 0) FROM stock_ledger l
               WHERE l.stage = 'RAW' AND l.lot_type = 'purchase' AND l.lot_id = p.id) AS remainingCm
       FROM purchases p
       JOIN vendors v ON v.id = p.vendor_id
       JOIN models m ON m.id = p.model_id
       JOIN colors c ON c.id = p.color_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY p.id DESC`,
    )
    .all(...params) as Array<Record<string, unknown>>;
}
