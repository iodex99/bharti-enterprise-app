import type { OpeningBalanceInput } from '@shared';
import type { Db } from '../db/connection';
import { nowIso } from '../db/connection';
import { audit } from './audit.service';
import { nextDocNo } from './docNo.service';
import { LedgerError, postMovements } from './ledger.service';
import type { ServiceResult } from './purchases.service';

/**
 * Opening balances bring the paper-register stock into the system at go-live
 * (admin-only). Each creates its own ledger lot (lot_type 'opening') at the chosen
 * stage; qty is cm for RAW, pieces elsewhere.
 */
export function createOpeningBalance(
  db: Db,
  input: OpeningBalanceInput,
  userId: number,
  ip: string | null,
): ServiceResult<{ id: number; docNo: string }> {
  let id = 0;
  let docNo = '';
  const tx = db.transaction(() => {
    docNo = nextDocNo(db, 'opening');
    const info = db
      .prepare(
        `INSERT INTO opening_balances (doc_no, balance_date, stage, model_id, color_id,
          size_id, contractor_id, qty, note, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        docNo,
        input.balanceDate,
        input.stage,
        input.modelId,
        input.colorId,
        input.stage === 'RAW' ? null : input.sizeId,
        input.stage === 'WIP' ? input.contractorId : null,
        input.qty,
        input.note,
        userId,
      );
    id = Number(info.lastInsertRowid);
    postMovements(
      db,
      [
        {
          stage: input.stage,
          modelId: input.modelId,
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
      new: { docNo, ...input },
      ip,
    });
  });
  tx();
  return { ok: true, id, docNo };
}

export function voidOpeningBalance(
  db: Db,
  id: number,
  reason: string,
  userId: number,
  ip: string | null,
): ServiceResult {
  const existing = db
    .prepare('SELECT * FROM opening_balances WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;
  if (!existing) return { ok: false, code: 404, error: 'Opening balance not found.' };
  if (existing.voided_at) return { ok: false, code: 409, error: 'Already voided.' };

  try {
    const tx = db.transaction(() => {
      postMovements(
        db,
        [
          {
            stage: existing.stage as never,
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

export function listOpeningBalances(db: Db): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT o.id, o.doc_no AS docNo, o.balance_date AS balanceDate, o.stage,
              o.model_id AS modelId, m.code AS modelCode,
              o.color_id AS colorId, c.name AS colorName,
              o.size_id AS sizeId, s.code AS sizeCode,
              o.contractor_id AS contractorId, ct.name AS contractorName,
              o.qty, o.note, o.voided_at AS voidedAt
       FROM opening_balances o
       JOIN models m ON m.id = o.model_id
       JOIN colors c ON c.id = o.color_id
       LEFT JOIN sizes s ON s.id = o.size_id
       LEFT JOIN contractors ct ON ct.id = o.contractor_id
       ORDER BY o.id DESC`,
    )
    .all() as Array<Record<string, unknown>>;
}
