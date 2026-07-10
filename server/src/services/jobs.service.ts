import type { JobCardInput, JobCloseInput, JobReceiptInput } from '@shared';
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
 * Module 5/6: contractor job work.
 * Issue: CUT −qty (FIFO across cut lots, allocations recorded) → WIP +qty per job line.
 * Receipt (partial-friendly):
 *   stitched          WIP −qty → CHECKING +qty (lot = receipt_line); excess beyond WIP
 *                     becomes receipt_excess genesis + a discrepancy row (reason required).
 *   unstitched_return WIP −qty → CUT +qty back onto the originally allocated lots (LIFO).
 * Close (admin): remaining WIP written off as job_shortage + discrepancy rows.
 * Status: open → partially_received → completed (auto when every line settles exactly)
 *         or closed_with_discrepancy (admin).
 */

type JobLineRow = {
  id: number;
  job_card_id: number;
  size_id: number;
  qty_issued_pcs: number;
  rate_paise_per_dozen: number;
};

function lineTotals(db: Db, lineId: number): { stitched: number; unstitched: number } {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN rl.return_type = 'stitched' THEN rl.qty_pcs END), 0) AS stitched,
         COALESCE(SUM(CASE WHEN rl.return_type = 'unstitched_return' THEN rl.qty_pcs END), 0) AS unstitched
       FROM job_receipt_lines rl
       JOIN job_receipts r ON r.id = rl.job_receipt_id AND r.voided_at IS NULL
       WHERE rl.job_card_line_id = ?`,
    )
    .get(lineId) as { stitched: number; unstitched: number };
  return row;
}

/** Recompute the denormalized card status from its lines. Call inside the transaction. */
function refreshJobStatus(db: Db, jobCardId: number): string {
  const card = db
    .prepare('SELECT status FROM job_cards WHERE id = ?')
    .get(jobCardId) as { status: string };
  if (card.status === 'closed_with_discrepancy') return card.status;

  const lines = db
    .prepare('SELECT id, qty_issued_pcs FROM job_card_lines WHERE job_card_id = ?')
    .all(jobCardId) as Array<{ id: number; qty_issued_pcs: number }>;
  let anyReceipt = false;
  let allSettled = true;
  for (const line of lines) {
    const t = lineTotals(db, line.id);
    if (t.stitched + t.unstitched > 0) anyReceipt = true;
    if (t.stitched + t.unstitched < line.qty_issued_pcs) allSettled = false;
  }
  const status = allSettled ? 'completed' : anyReceipt ? 'partially_received' : 'open';
  db.prepare('UPDATE job_cards SET status = ? WHERE id = ?').run(status, jobCardId);
  return status;
}

export function createJobCard(
  db: Db,
  input: JobCardInput,
  userId: number,
  ip: string | null,
  onCreated?: (id: number) => void,
): ServiceResult<{ id: number; docNo: string }> {
  const contractor = db
    .prepare('SELECT is_active FROM contractors WHERE id = ? AND deleted_at IS NULL')
    .get(input.contractorId) as { is_active: number } | undefined;
  if (!contractor) return { ok: false, code: 400, error: 'Contractor not found.' };
  if (!contractor.is_active) {
    return { ok: false, code: 400, error: 'Contractor is deactivated — no new job cards.' };
  }

  let id = 0;
  let docNo = '';
  try {
    const tx = db.transaction(() => {
      docNo = nextDocNo(db, 'job');
      const info = db
        .prepare(
          `INSERT INTO job_cards (doc_no, issue_date, contractor_id, model_id, color_id, notes, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(docNo, input.issueDate, input.contractorId, input.modelId, input.colorId, input.notes, userId);
      id = Number(info.lastInsertRowid);

      const insertLine = db.prepare(
        `INSERT INTO job_card_lines (job_card_id, size_id, qty_issued_pcs, unit_entered, rate_paise_per_dozen)
         VALUES (?, ?, ?, ?, ?)`,
      );
      const insertAlloc = db.prepare(
        `INSERT INTO job_allocations (job_card_line_id, cut_lot_type, cut_lot_id, qty_pcs)
         VALUES (?, ?, ?, ?)`,
      );

      for (const line of input.lines) {
        const lineInfo = insertLine.run(
          id,
          line.sizeId,
          line.qtyIssuedPcs,
          line.unitEntered,
          line.ratePaisePerDozen,
        );
        const lineId = Number(lineInfo.lastInsertRowid);

        // FIFO across available CUT lots for this model/color/size
        const lots = availableLots(db, {
          stage: 'CUT',
          modelId: input.modelId,
          colorId: input.colorId,
          sizeId: line.sizeId,
        });
        const totalAvailable = lots.reduce((s, l) => s + l.qty, 0);
        if (totalAvailable < line.qtyIssuedPcs) {
          throw new LedgerError(
            `Not enough cut stock for size line: needed ${line.qtyIssuedPcs} pcs, available ${totalAvailable} pcs.`,
          );
        }
        const takes = splitFifo(lots, line.qtyIssuedPcs);
        const movements: Movement[] = [];
        for (const take of takes) {
          movements.push({
            stage: 'CUT',
            modelId: input.modelId,
            colorId: input.colorId,
            sizeId: line.sizeId,
            lotType: take.lotType,
            lotId: take.lotId,
            qty: -take.qty,
            refType: 'job_issue',
            refId: lineId,
          });
          insertAlloc.run(lineId, take.lotType, take.lotId, take.qty);
        }
        movements.push({
          stage: 'WIP',
          modelId: input.modelId,
          colorId: input.colorId,
          sizeId: line.sizeId,
          contractorId: input.contractorId,
          lotType: 'job_line',
          lotId: lineId,
          qty: line.qtyIssuedPcs,
          refType: 'job_issue',
          refId: lineId,
        });
        postMovements(db, movements, userId);
      }

      audit(db, { userId, action: 'create', entityType: 'job_card', entityId: id, new: { docNo, ...input }, ip });
      onCreated?.(id);
    });
    tx();
  } catch (err) {
    if (err instanceof LedgerError) return { ok: false, code: 409, error: err.message };
    throw err;
  }
  return { ok: true, id, docNo };
}

export function createReceipt(
  db: Db,
  jobCardId: number,
  input: JobReceiptInput,
  userId: number,
  ip: string | null,
  onCreated?: (id: number) => void,
): ServiceResult<{ id: number; docNo: string; status: string }> {
  const card = db
    .prepare('SELECT * FROM job_cards WHERE id = ? AND voided_at IS NULL')
    .get(jobCardId) as Record<string, unknown> | undefined;
  if (!card) return { ok: false, code: 404, error: 'Job card not found.' };
  if (card.status === 'closed_with_discrepancy') {
    return { ok: false, code: 409, error: 'This job was closed with a discrepancy — no more receipts.' };
  }

  const lines = db
    .prepare('SELECT * FROM job_card_lines WHERE job_card_id = ?')
    .all(jobCardId) as JobLineRow[];
  const linesById = new Map(lines.map((l) => [l.id, l]));

  for (const rl of input.lines) {
    if (!linesById.has(rl.jobCardLineId)) {
      return { ok: false, code: 400, error: 'A receipt line refers to a different job card.' };
    }
  }

  let id = 0;
  let docNo = '';
  let status = String(card.status);
  try {
    const tx = db.transaction(() => {
      docNo = nextDocNo(db, 'receipt');
      const info = db
        .prepare(
          `INSERT INTO job_receipts (doc_no, job_card_id, receipt_date, notes, created_by)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(docNo, jobCardId, input.receiptDate, input.notes, userId);
      id = Number(info.lastInsertRowid);

      const insertReceiptLine = db.prepare(
        `INSERT INTO job_receipt_lines (job_receipt_id, job_card_line_id, qty_pcs, return_type)
         VALUES (?, ?, ?, ?)`,
      );

      for (const rl of input.lines) {
        const jobLine = linesById.get(rl.jobCardLineId)!;
        const rlInfo = insertReceiptLine.run(id, rl.jobCardLineId, rl.qtyPcs, rl.returnType);
        const receiptLineId = Number(rlInfo.lastInsertRowid);

        const wipBalance = (
          db
            .prepare(
              `SELECT COALESCE(SUM(qty),0) AS bal FROM stock_ledger
               WHERE stage='WIP' AND lot_type='job_line' AND lot_id = ?`,
            )
            .get(jobLine.id) as { bal: number }
        ).bal;

        if (rl.returnType === 'stitched') {
          const fromWip = Math.min(rl.qtyPcs, wipBalance);
          const excess = rl.qtyPcs - fromWip;
          if (excess > 0 && !rl.discrepancyReason) {
            throw new LedgerError(
              `Received more than pending on a line (${excess} pcs extra) — a discrepancy reason is required.`,
            );
          }
          const movements: Movement[] = [];
          if (fromWip > 0) {
            movements.push(
              {
                stage: 'WIP',
                modelId: card.model_id as number,
                colorId: card.color_id as number,
                sizeId: jobLine.size_id,
                contractorId: card.contractor_id as number,
                lotType: 'job_line',
                lotId: jobLine.id,
                qty: -fromWip,
                refType: 'job_receipt',
                refId: receiptLineId,
              },
              {
                stage: 'CHECKING',
                modelId: card.model_id as number,
                colorId: card.color_id as number,
                sizeId: jobLine.size_id,
                lotType: 'receipt_line',
                lotId: receiptLineId,
                qty: fromWip,
                refType: 'job_receipt',
                refId: receiptLineId,
              },
            );
          }
          if (excess > 0) {
            movements.push({
              stage: 'CHECKING',
              modelId: card.model_id as number,
              colorId: card.color_id as number,
              sizeId: jobLine.size_id,
              lotType: 'receipt_line',
              lotId: receiptLineId,
              qty: excess,
              refType: 'receipt_excess',
              refId: receiptLineId,
            });
            db.prepare(
              `INSERT INTO discrepancies (stage, ref_type, ref_id, qty_pcs, reason, note, created_by)
               VALUES ('WIP', 'job_card_line', ?, ?, ?, ?, ?)`,
            ).run(jobLine.id, excess, rl.discrepancyReason, rl.discrepancyNote ?? '', userId);
          }
          postMovements(db, movements, userId);
        } else {
          // unstitched_return: back to the allocated CUT lots, most recent first
          if (rl.qtyPcs > wipBalance) {
            throw new LedgerError(
              `Cannot return ${rl.qtyPcs} unstitched pcs — only ${wipBalance} pcs are with the contractor on this line.`,
            );
          }
          const allocations = db
            .prepare(
              `SELECT cut_lot_type, cut_lot_id, qty_pcs FROM job_allocations
               WHERE job_card_line_id = ? ORDER BY id DESC`,
            )
            .all(jobLine.id) as Array<{ cut_lot_type: 'cutting_line' | 'opening'; cut_lot_id: number; qty_pcs: number }>;
          const movements: Movement[] = [
            {
              stage: 'WIP',
              modelId: card.model_id as number,
              colorId: card.color_id as number,
              sizeId: jobLine.size_id,
              contractorId: card.contractor_id as number,
              lotType: 'job_line',
              lotId: jobLine.id,
              qty: -rl.qtyPcs,
              refType: 'unstitched_return',
              refId: receiptLineId,
            },
          ];
          let remaining = rl.qtyPcs;
          for (const alloc of allocations) {
            if (remaining === 0) break;
            const back = Math.min(alloc.qty_pcs, remaining);
            movements.push({
              stage: 'CUT',
              modelId: card.model_id as number,
              colorId: card.color_id as number,
              sizeId: jobLine.size_id,
              lotType: alloc.cut_lot_type,
              lotId: alloc.cut_lot_id,
              qty: back,
              refType: 'unstitched_return',
              refId: receiptLineId,
            });
            remaining -= back;
          }
          if (remaining > 0) {
            // allocations should always cover the issue; guard anyway
            throw new LedgerError('Return exceeds this line’s recorded allocations.');
          }
          postMovements(db, movements, userId);
        }
      }

      status = refreshJobStatus(db, jobCardId);
      audit(db, { userId, action: 'create', entityType: 'job_receipt', entityId: id, new: { docNo, jobCardId, ...input }, ip });
      onCreated?.(id);
    });
    tx();
  } catch (err) {
    if (err instanceof LedgerError) return { ok: false, code: 409, error: err.message };
    throw err;
  }
  return { ok: true, id, docNo, status };
}

export function closeJobWithDiscrepancy(
  db: Db,
  jobCardId: number,
  input: JobCloseInput,
  userId: number,
  ip: string | null,
): ServiceResult<{ id: number; shortagePcs: number }> {
  const card = db
    .prepare('SELECT * FROM job_cards WHERE id = ? AND voided_at IS NULL')
    .get(jobCardId) as Record<string, unknown> | undefined;
  if (!card) return { ok: false, code: 404, error: 'Job card not found.' };
  if (card.status === 'completed' || card.status === 'closed_with_discrepancy') {
    return { ok: false, code: 409, error: 'Job is already settled.' };
  }

  const lines = db
    .prepare('SELECT * FROM job_card_lines WHERE job_card_id = ?')
    .all(jobCardId) as JobLineRow[];

  let shortageTotal = 0;
  const tx = db.transaction(() => {
    for (const line of lines) {
      const wipBalance = (
        db
          .prepare(
            `SELECT COALESCE(SUM(qty),0) AS bal FROM stock_ledger
             WHERE stage='WIP' AND lot_type='job_line' AND lot_id = ?`,
          )
          .get(line.id) as { bal: number }
      ).bal;
      if (wipBalance > 0) {
        shortageTotal += wipBalance;
        postMovements(
          db,
          [
            {
              stage: 'WIP',
              modelId: card.model_id as number,
              colorId: card.color_id as number,
              sizeId: line.size_id,
              contractorId: card.contractor_id as number,
              lotType: 'job_line',
              lotId: line.id,
              qty: -wipBalance,
              refType: 'job_shortage',
              refId: line.id,
            },
          ],
          userId,
        );
        db.prepare(
          `INSERT INTO discrepancies (stage, ref_type, ref_id, qty_pcs, reason, note, created_by)
           VALUES ('WIP', 'job_card_line', ?, ?, ?, ?, ?)`,
        ).run(line.id, -wipBalance, input.reason, input.note, userId);
      }
    }
    db.prepare(
      `UPDATE job_cards SET status = 'closed_with_discrepancy', closed_at = ?, closed_by = ?, close_note = ?
       WHERE id = ?`,
    ).run(nowIso(), userId, `${input.reason}: ${input.note}`, jobCardId);
    audit(db, {
      userId,
      action: 'close_with_discrepancy',
      entityType: 'job_card',
      entityId: jobCardId,
      new: { ...input, shortagePcs: shortageTotal },
      ip,
    });
  });
  tx();
  return { ok: true, id: jobCardId, shortagePcs: shortageTotal };
}

export function voidJobCard(
  db: Db,
  jobCardId: number,
  reason: string,
  userId: number,
  ip: string | null,
): ServiceResult {
  const card = db
    .prepare('SELECT * FROM job_cards WHERE id = ?')
    .get(jobCardId) as Record<string, unknown> | undefined;
  if (!card) return { ok: false, code: 404, error: 'Job card not found.' };
  if (card.voided_at) return { ok: false, code: 409, error: 'Already voided.' };

  const receiptCount = (
    db
      .prepare('SELECT COUNT(*) AS n FROM job_receipts WHERE job_card_id = ? AND voided_at IS NULL')
      .get(jobCardId) as { n: number }
  ).n;
  if (receiptCount > 0) {
    return {
      ok: false,
      code: 409,
      error: 'Cannot void: receipts exist for this job card. Void is only for unstarted jobs.',
    };
  }

  const lines = db
    .prepare('SELECT * FROM job_card_lines WHERE job_card_id = ?')
    .all(jobCardId) as JobLineRow[];

  const tx = db.transaction(() => {
    for (const line of lines) {
      const allocations = db
        .prepare(
          `SELECT cut_lot_type, cut_lot_id, qty_pcs FROM job_allocations WHERE job_card_line_id = ?`,
        )
        .all(line.id) as Array<{ cut_lot_type: 'cutting_line' | 'opening'; cut_lot_id: number; qty_pcs: number }>;
      const movements: Movement[] = [
        {
          stage: 'WIP',
          modelId: card.model_id as number,
          colorId: card.color_id as number,
          sizeId: line.size_id,
          contractorId: card.contractor_id as number,
          lotType: 'job_line',
          lotId: line.id,
          qty: -line.qty_issued_pcs,
          refType: 'void_reversal',
          refId: line.id,
        },
        ...allocations.map((alloc) => ({
          stage: 'CUT' as const,
          modelId: card.model_id as number,
          colorId: card.color_id as number,
          sizeId: line.size_id,
          lotType: alloc.cut_lot_type,
          lotId: alloc.cut_lot_id,
          qty: alloc.qty_pcs,
          refType: 'void_reversal' as const,
          refId: line.id,
        })),
      ];
      postMovements(db, movements, userId);
    }
    db.prepare('UPDATE job_cards SET voided_at = ?, void_reason = ?, voided_by = ? WHERE id = ?').run(
      nowIso(),
      reason,
      userId,
      jobCardId,
    );
    audit(db, { userId, action: 'void', entityType: 'job_card', entityId: jobCardId, new: { reason }, ip });
  });
  tx();
  return { ok: true, id: jobCardId };
}

// ---------------------------------------------------------------------------
// queries
// ---------------------------------------------------------------------------

export function listJobCards(
  db: Db,
  f: { status?: string; contractorId?: number; includeVoided?: boolean } = {},
): Array<Record<string, unknown>> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!f.includeVoided) where.push('j.voided_at IS NULL');
  if (f.status) {
    where.push('j.status = ?');
    params.push(f.status);
  }
  if (f.contractorId) {
    where.push('j.contractor_id = ?');
    params.push(f.contractorId);
  }
  const cards = db
    .prepare(
      `SELECT j.id, j.doc_no AS docNo, j.issue_date AS issueDate, j.status, j.notes,
              j.closed_at AS closedAt, j.close_note AS closeNote, j.voided_at AS voidedAt,
              j.contractor_id AS contractorId, ct.name AS contractorName,
              j.model_id AS modelId, m.code AS modelCode,
              j.color_id AS colorId, c.name AS colorName
       FROM job_cards j
       JOIN contractors ct ON ct.id = j.contractor_id
       JOIN models m ON m.id = j.model_id
       JOIN colors c ON c.id = j.color_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY j.id DESC`,
    )
    .all(...params) as Array<Record<string, unknown>>;

  const lineStmt = db.prepare(
    `SELECT l.id, l.size_id AS sizeId, s.code AS sizeCode, l.qty_issued_pcs AS qtyIssuedPcs,
            l.unit_entered AS unitEntered, l.rate_paise_per_dozen AS ratePaisePerDozen
     FROM job_card_lines l JOIN sizes s ON s.id = l.size_id
     WHERE l.job_card_id = ? ORDER BY s.sort_order, s.code`,
  );
  const totalsStmt = db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN rl.return_type = 'stitched' THEN rl.qty_pcs END), 0) AS stitched,
       COALESCE(SUM(CASE WHEN rl.return_type = 'unstitched_return' THEN rl.qty_pcs END), 0) AS unstitched
     FROM job_receipt_lines rl
     JOIN job_receipts r ON r.id = rl.job_receipt_id AND r.voided_at IS NULL
     WHERE rl.job_card_line_id = ?`,
  );

  for (const card of cards) {
    const lines = lineStmt.all(card.id) as Array<Record<string, unknown>>;
    let issued = 0;
    let received = 0;
    let returned = 0;
    for (const line of lines) {
      const t = totalsStmt.get(line.id) as { stitched: number; unstitched: number };
      line.receivedPcs = t.stitched;
      line.returnedPcs = t.unstitched;
      line.pendingPcs = Math.max(
        0,
        (line.qtyIssuedPcs as number) - t.stitched - t.unstitched,
      );
      line.excessPcs = Math.max(
        0,
        t.stitched + t.unstitched - (line.qtyIssuedPcs as number),
      );
      issued += line.qtyIssuedPcs as number;
      received += t.stitched;
      returned += t.unstitched;
    }
    card.lines = lines;
    card.issuedPcs = issued;
    card.receivedPcs = received;
    card.returnedPcs = returned;
    card.pendingPcs = lines.reduce((s, l) => s + (l.pendingPcs as number), 0);
    card.jobCostPaise = lines.reduce(
      (s, l) =>
        s + Math.round(((l.receivedPcs as number) * (l.ratePaisePerDozen as number)) / 12),
      0,
    );
  }
  return cards;
}

export function jobReceiptsFor(db: Db, jobCardId: number): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT r.id, r.doc_no AS docNo, r.receipt_date AS receiptDate, r.notes,
              rl.job_card_line_id AS jobCardLineId, rl.qty_pcs AS qtyPcs, rl.return_type AS returnType,
              s.code AS sizeCode
       FROM job_receipts r
       JOIN job_receipt_lines rl ON rl.job_receipt_id = r.id
       JOIN job_card_lines l ON l.id = rl.job_card_line_id
       JOIN sizes s ON s.id = l.size_id
       WHERE r.job_card_id = ? AND r.voided_at IS NULL
       ORDER BY r.id DESC`,
    )
    .all(jobCardId) as Array<Record<string, unknown>>;
}
