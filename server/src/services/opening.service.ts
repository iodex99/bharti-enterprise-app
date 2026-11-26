import type { OpeningBalanceInput, OpeningEditInput } from '@shared';
import type { Db } from '../db/connection';
import { nowIso } from '../db/connection';
import { audit } from './audit.service';
import { nextDocNo } from './docNo.service';
import { LedgerError, postMovements } from './ledger.service';
import type { Office } from './offices.service';
import { modelIdForCode } from './products.service';
import { assertActive, rawClothModelId, type ServiceResult } from './purchases.service';

/**
 * Opening balances bring the paper-register stock into the system at go-live
 * (admin-only). Each creates its own ledger lot (lot_type 'opening') at the chosen
 * stage IN THE ACTIVE OFFICE; qty is hundredths of an inch of length for RAW (entered
 * as yards, with the cloth width), pieces elsewhere. Stitched stages take the CODE as
 * typed at cutting — the product identity is created from it (ADR-030).
 */
export function createOpeningBalance(
  db: Db,
  office: Office,
  input: OpeningBalanceInput,
  userId: number,
  ip: string | null,
): ServiceResult<{ id: number; docNo: string }> {
  const checks: Array<[string, number | null | undefined, string]> = [
    ['colors', input.colorId, 'Color'],
    ['sizes', input.stage === 'RAW' ? null : input.sizeId, 'Size'],
    ['contractors', input.stage === 'WIP' ? input.contractorId : null, 'Contractor'],
  ];
  for (const [table, id, label] of checks) {
    if (id == null) continue;
    const err = assertActive(db, table, id, label);
    if (err) return { ok: false, code: 400, error: err };
  }
  if (input.stage === 'RAW' && !input.widthInchC) {
    return { ok: false, code: 400, error: 'Enter the cloth width for a raw-cloth opening lot.' };
  }

  let id = 0;
  let docNo = '';
  const tx = db.transaction(() => {
    // RAW carries no code (given at cutting); other stages create/reuse the typed code
    const modelId =
      input.stage === 'RAW'
        ? rawClothModelId(db)
        : modelIdForCode(db, input.modelCode as string, userId);
    docNo = nextDocNo(db, 'opening', office);
    const info = db
      .prepare(
        `INSERT INTO opening_balances (doc_no, office_id, balance_date, stage, model_id, color_id,
          size_id, contractor_id, qty, width_inch_c, note, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        docNo,
        office.id,
        input.balanceDate,
        input.stage,
        modelId,
        input.colorId,
        input.stage === 'RAW' ? null : input.sizeId,
        input.stage === 'WIP' ? input.contractorId : null,
        input.qty,
        input.stage === 'RAW' ? (input.widthInchC ?? null) : null,
        input.note,
        userId,
      );
    id = Number(info.lastInsertRowid);
    postMovements(
      db,
      [
        {
          stage: input.stage,
          officeId: office.id,
          modelId,
          colorId: input.colorId,
          sizeId: input.stage === 'RAW' ? null : (input.sizeId as number),
          contractorId: input.stage === 'WIP' ? input.contractorId : null,
          lotType: 'opening',
          lotId: id,
          qty: input.qty,
          refType: 'opening',
          refId: id,
        },
      ],
      userId,
    );
    audit(db, {
      userId,
      action: 'create',
      entityType: 'opening_balance',
      entityId: id,
      new: { docNo, officeId: office.id, ...input },
      ip,
    });
  });
  tx();
  return { ok: true, id, docNo };
}

export function voidOpeningBalance(
  db: Db,
  office: Office,
  id: number,
  reason: string,
  userId: number,
  ip: string | null,
): ServiceResult {
  const existing = db
    .prepare('SELECT * FROM opening_balances WHERE id = ? AND office_id = ?')
    .get(id, office.id) as Record<string, unknown> | undefined;
  if (!existing) return { ok: false, code: 404, error: 'Opening balance not found.' };
  if (existing.voided_at) return { ok: false, code: 409, error: 'Already voided.' };

  try {
    const tx = db.transaction(() => {
      postMovements(
        db,
        [
          {
            stage: existing.stage as never,
            officeId: office.id,
            modelId: existing.model_id as number,
            colorId: existing.color_id as number,
            sizeId: existing.size_id as number | null,
            contractorId: existing.contractor_id as number | null,
            lotType: 'opening',
            lotId: id,
            qty: -(existing.qty as number),
            refType: 'adjustment_out',
            refId: id,
          },
        ],
        userId,
      );
      db.prepare(
        'UPDATE opening_balances SET voided_at = ?, void_reason = ?, voided_by = ? WHERE id = ?',
      ).run(nowIso(), reason, userId, id);
      audit(db, {
        userId,
        action: 'void',
        entityType: 'opening_balance',
        entityId: id,
        new: { reason },
        ip,
      });
    });
    tx();
  } catch (err) {
    if (err instanceof LedgerError) {
      return {
        ok: false,
        code: 409,
        error: 'Cannot void: this opening stock was already used downstream.',
      };
    }
    throw err;
  }
  return { ok: true, id };
}

/**
 * Correct an opening balance's date, quantity or note. A quantity change posts the
 * difference to the lot (adjustment in/out); it can never drop below what was already
 * used downstream — the ledger's no-negative-lot rule refuses that.
 */
export function editOpeningBalance(
  db: Db,
  office: Office,
  id: number,
  input: OpeningEditInput,
  userId: number,
  ip: string | null,
): ServiceResult {
  const existing = db
    .prepare('SELECT * FROM opening_balances WHERE id = ? AND office_id = ? AND voided_at IS NULL')
    .get(id, office.id) as Record<string, unknown> | undefined;
  if (!existing) return { ok: false, code: 404, error: 'Opening balance not found.' };
  const delta = input.qty - (existing.qty as number);
  try {
    const tx = db.transaction(() => {
      if (delta !== 0) {
        postMovements(
          db,
          [
            {
              stage: existing.stage as never,
              officeId: office.id,
              modelId: existing.model_id as number,
              colorId: existing.color_id as number,
              sizeId: existing.size_id as number | null,
              contractorId: existing.contractor_id as number | null,
              lotType: 'opening',
              lotId: id,
              qty: delta,
              refType: delta > 0 ? 'adjustment_in' : 'adjustment_out',
              refId: id,
            },
          ],
          userId,
        );
      }
      db.prepare(
        'UPDATE opening_balances SET balance_date = ?, qty = ?, width_inch_c = ?, note = ? WHERE id = ?',
      ).run(
        input.balanceDate,
        input.qty,
        existing.stage === 'RAW' ? (input.widthInchC ?? existing.width_inch_c ?? null) : null,
        input.note,
        id,
      );
      audit(db, {
        userId,
        action: 'update',
        entityType: 'opening_balance',
        entityId: id,
        old: {
          balanceDate: existing.balance_date,
          qty: existing.qty,
          widthInchC: existing.width_inch_c,
          note: existing.note,
        },
        new: input,
        ip,
      });
    });
    tx();
  } catch (err) {
    if (err instanceof LedgerError) {
      return {
        ok: false,
        code: 409,
        error: 'Cannot reduce it that far: some of this opening stock was already used.',
      };
    }
    throw err;
  }
  return { ok: true, id };
}

export function listOpeningBalances(db: Db, officeId: number): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT o.id, o.doc_no AS docNo, o.balance_date AS balanceDate, o.stage,
              o.model_id AS modelId, m.code AS modelCode,
              o.color_id AS colorId, c.name AS colorName,
              o.size_id AS sizeId, s.code AS sizeCode,
              o.contractor_id AS contractorId, ct.name AS contractorName,
              o.qty, o.width_inch_c AS widthInchC, o.note, o.voided_at AS voidedAt
       FROM opening_balances o
       JOIN models m ON m.id = o.model_id
       JOIN colors c ON c.id = o.color_id
       LEFT JOIN sizes s ON s.id = o.size_id
       LEFT JOIN contractors ct ON ct.id = o.contractor_id
       WHERE o.office_id = ?
       ORDER BY o.id DESC`,
    )
    .all(officeId) as Array<Record<string, unknown>>;
}
