import { RAW_CLOTH_MODEL_CODE, type PurchaseEditInput, type PurchaseInput } from '@shared';
import type { Db } from '../db/connection';
import { nowIso } from '../db/connection';
import { audit } from './audit.service';
import { nextDocNo } from './docNo.service';
import { LedgerError, postMovements } from './ledger.service';
import type { Office } from './offices.service';

/**
 * Module 1: raw-cloth purchases (v2, ADR-028/029).
 * Cloth is bought as vendor + color + LENGTH IN YARDS + WIDTH IN INCHES (both stored as
 * integer hundredths of an inch); the code is only given at cutting. Each purchase
 * belongs to the office it was recorded in and creates that office's RAW lot.
 */

/** total = yards × rate/yard; len_inch_c / 3600 gives yards. Server-computed. */
export function purchaseTotalPaise(lenInchC: number, ratePaisePerYard: number): number {
  return Math.round((lenInchC * ratePaisePerYard) / 3600);
}

/** Legacy NOT NULL column — kept written (≈cm) so old constraints hold; never read. */
function legacyCm(lenInchC: number): number {
  return Math.max(1, Math.round((lenInchC * 254) / 10000));
}

/**
 * The sentinel model that fills NOT NULL model columns for raw cloth — the real code is
 * only given at cutting. Inserted by migration 002; inactive so it never appears in
 * pickers or new-document validation.
 */
export function rawClothModelId(db: Db): number {
  const row = db.prepare('SELECT id FROM models WHERE code = ?').get(RAW_CLOTH_MODEL_CODE) as
    { id: number } | undefined;
  if (!row) throw new Error('RAW-CLOTH sentinel model missing — migrations not applied?');
  return row.id;
}

export type ServiceResult<T = { id: number }> =
  ({ ok: true } & T) | { ok: false; code: number; error: string };

export function assertActive(db: Db, table: string, id: number, label: string): string | null {
  const row = db
    .prepare(`SELECT is_active FROM ${table} WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as { is_active: number } | undefined;
  if (!row) return `${label} not found.`;
  if (!row.is_active) return `${label} is deactivated — reactivate it or pick another.`;
  return null;
}

export function createPurchase(
  db: Db,
  office: Office,
  input: PurchaseInput,
  userId: number,
  ip: string | null,
  onCreated?: (id: number) => void,
): ServiceResult<{ id: number; docNo: string }> {
  for (const [table, id, label] of [
    ['vendors', input.vendorId, 'Vendor'],
    ['colors', input.colorId, 'Color'],
  ] as const) {
    const err = assertActive(db, table, id, label);
    if (err) return { ok: false, code: 400, error: err };
  }

  const rawModel = rawClothModelId(db);
  let id = 0;
  let docNo = '';
  const tx = db.transaction(() => {
    docNo = nextDocNo(db, 'purchase', office);
    const info = db
      .prepare(
        `INSERT INTO purchases (doc_no, office_id, purchase_date, received_date, vendor_id,
          model_id, color_id, len_inch_c, width_inch_c, rate_paise_per_yard,
          qty_cm, rate_paise_per_meter, total_paise, image_path, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      )
      .run(
        docNo,
        office.id,
        input.purchaseDate,
        input.receivedDate,
        input.vendorId,
        rawModel,
        input.colorId,
        input.lenInchC,
        input.widthInchC,
        input.ratePaisePerYard,
        legacyCm(input.lenInchC),
        purchaseTotalPaise(input.lenInchC, input.ratePaisePerYard),
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
          officeId: office.id,
          modelId: rawModel,
          colorId: input.colorId,
          sizeId: null,
          lotType: 'purchase',
          lotId: id,
          qty: input.lenInchC,
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
      new: { docNo, officeId: office.id, ...input },
      ip,
    });
    onCreated?.(id);
  });
  tx();
  return { ok: true, id, docNo };
}

export function editPurchase(
  db: Db,
  office: Office,
  id: number,
  input: PurchaseEditInput,
  userId: number,
  ip: string | null,
): ServiceResult {
  const existing = db
    .prepare('SELECT * FROM purchases WHERE id = ? AND office_id = ? AND voided_at IS NULL')
    .get(id, office.id) as Record<string, unknown> | undefined;
  if (!existing) return { ok: false, code: 404, error: 'Purchase not found.' };

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE purchases SET rate_paise_per_yard = ?, total_paise = ?, image_path = ?, notes = ?
       WHERE id = ?`,
    ).run(
      input.ratePaisePerYard,
      purchaseTotalPaise(existing.len_inch_c as number, input.ratePaisePerYard),
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
        ratePaisePerYard: existing.rate_paise_per_yard,
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
  office: Office,
  id: number,
  reason: string,
  userId: number,
  ip: string | null,
): ServiceResult {
  const existing = db
    .prepare('SELECT * FROM purchases WHERE id = ? AND office_id = ?')
    .get(id, office.id) as Record<string, unknown> | undefined;
  if (!existing) return { ok: false, code: 404, error: 'Purchase not found.' };
  if (existing.voided_at) return { ok: false, code: 409, error: 'Purchase is already voided.' };

  // Downstream consumption blocks the void: the RAW lot must still be untouched.
  const { bal } = db
    .prepare(
      `SELECT COALESCE(SUM(qty), 0) AS bal FROM stock_ledger
       WHERE stage = 'RAW' AND lot_type = 'purchase' AND lot_id = ?`,
    )
    .get(id) as { bal: number };
  if (bal !== (existing.len_inch_c as number)) {
    const consumer = db
      .prepare(
        `SELECT cb.doc_no FROM cutting_batches cb
         WHERE cb.raw_lot_type = 'purchase' AND cb.raw_lot_id = ? AND cb.voided_at IS NULL
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
            officeId: office.id,
            modelId: existing.model_id as number,
            colorId: existing.color_id as number,
            sizeId: null,
            lotType: 'purchase',
            lotId: id,
            qty: -(existing.len_inch_c as number),
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
  colorId?: number;
  from?: string;
  to?: string;
  includeVoided?: boolean;
};

export function listPurchases(
  db: Db,
  officeId: number,
  f: PurchaseListFilters,
): Array<Record<string, unknown>> {
  const where: string[] = ['p.office_id = ?'];
  const params: unknown[] = [officeId];
  if (!f.includeVoided) where.push('p.voided_at IS NULL');
  if (f.vendorId) {
    where.push('p.vendor_id = ?');
    params.push(f.vendorId);
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
  // no code here — raw cloth has no product code until it is cut
  return db
    .prepare(
      `SELECT p.id, p.doc_no AS docNo, p.purchase_date AS purchaseDate,
              p.received_date AS receivedDate,
              p.vendor_id AS vendorId, v.name AS vendorName,
              p.color_id AS colorId, c.name AS colorName,
              p.len_inch_c AS lenInchC, p.width_inch_c AS widthInchC,
              p.rate_paise_per_yard AS ratePaisePerYard,
              p.total_paise AS totalPaise, p.image_path AS imagePath, p.notes,
              p.voided_at AS voidedAt, p.void_reason AS voidReason,
              (SELECT COALESCE(SUM(l.qty), 0) FROM stock_ledger l
               WHERE l.stage = 'RAW' AND l.lot_type = 'purchase' AND l.lot_id = p.id) AS remainingInchC
       FROM purchases p
       JOIN vendors v ON v.id = p.vendor_id
       JOIN colors c ON c.id = p.color_id
       WHERE ${where.join(' AND ')}
       ORDER BY p.id DESC`,
    )
    .all(...params) as Array<Record<string, unknown>>;
}
