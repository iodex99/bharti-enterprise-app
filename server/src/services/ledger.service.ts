import { GENESIS_REF_TYPES, TERMINAL_REF_TYPES, type RefType, type Stage } from '@shared';
import type { Db } from '../db/connection';

/**
 * THE stock engine. Every inventory movement in the system flows through
 * postMovements(); nothing else may write stock_ledger.
 *
 * Hard rules (tested by the conservation suite):
 * - Callers MUST already be inside db.transaction() — availability check + write are
 *   then race-free because better-sqlite3 transactions are synchronous.
 * - GENESIS ref types only create (+qty); TERMINAL only destroy (−qty); TRANSFER types
 *   must net to zero within one postMovements() call.
 * - No lot may ever go negative.
 * - RAW rows carry size_id NULL and qty in cm; all other stages qty in pieces.
 */

export type Movement = {
  stage: Stage;
  /** every stock row belongs to exactly one office (ADR-028) */
  officeId: number;
  modelId: number;
  colorId: number;
  sizeId: number | null;
  contractorId?: number | null;
  staffId?: number | null;
  lotType: LotType;
  lotId: number;
  qty: number; // signed
  refType: RefType;
  refId: number;
};

export type LotType =
  | 'purchase' // RAW
  | 'cutting_line' // CUT
  | 'job_line' // WIP
  | 'receipt_line' // CHECKING pool
  | 'check_issue' // PACKING pool + REJECTED
  | 'pack_issue' // FG
  | 'opening'; // any stage (opening balances)

export class LedgerError extends Error {
  status = 400;
}

export class InsufficientStockError extends LedgerError {
  constructor(stage: Stage, needed: number, available: number) {
    super(
      `Not enough stock in ${stage}: needed ${needed}, available ${available}. ` +
        'Stock can only move through recorded transactions.',
    );
  }
}

const GENESIS = new Set<string>(GENESIS_REF_TYPES);
const TERMINAL = new Set<string>(TERMINAL_REF_TYPES);

export function postMovements(db: Db, movements: Movement[], userId: number): void {
  if (!db.inTransaction) {
    throw new Error('postMovements must run inside a db.transaction()');
  }
  if (movements.length === 0) return;

  // shape validation + conservation-by-construction
  const transferNet = new Map<string, number>();
  for (const m of movements) {
    if (!Number.isInteger(m.qty) || m.qty === 0) {
      throw new LedgerError(`Ledger quantities must be non-zero integers (got ${m.qty}).`);
    }
    if (!Number.isInteger(m.officeId) || m.officeId <= 0) {
      throw new LedgerError('Every movement must carry its office.');
    }
    if (m.stage === 'RAW' ? m.sizeId !== null : m.sizeId === null) {
      throw new LedgerError(
        `size is ${m.stage === 'RAW' ? 'not allowed' : 'required'} for ${m.stage}.`,
      );
    }
    if (GENESIS.has(m.refType) && m.qty < 0) {
      throw new LedgerError(`${m.refType} may only create stock (positive qty).`);
    }
    if (TERMINAL.has(m.refType) && m.qty > 0) {
      throw new LedgerError(`${m.refType} may only remove stock (negative qty).`);
    }
    if (!GENESIS.has(m.refType) && !TERMINAL.has(m.refType)) {
      const key = `${m.refType}:${m.refId}`;
      transferNet.set(key, (transferNet.get(key) ?? 0) + m.qty);
    }
  }
  for (const [key, net] of transferNet) {
    if (net !== 0) {
      throw new LedgerError(`Transfer ${key} does not balance (net ${net}); movements must pair.`);
    }
  }

  // availability per lot for all outgoing rows (grouped so multi-row draws validate together)
  const outgoingByLot = new Map<string, { m: Movement; total: number }>();
  for (const m of movements) {
    if (m.qty < 0) {
      const key = `${m.stage}|${m.lotType}|${m.lotId}`;
      const entry = outgoingByLot.get(key) ?? { m, total: 0 };
      entry.total += -m.qty;
      outgoingByLot.set(key, entry);
    }
  }
  const balanceStmt = db.prepare(
    `SELECT COALESCE(SUM(qty), 0) AS bal FROM stock_ledger
     WHERE office_id = ? AND stage = ? AND lot_type = ? AND lot_id = ?`,
  );
  for (const { m, total } of outgoingByLot.values()) {
    const { bal } = balanceStmt.get(m.officeId, m.stage, m.lotType, m.lotId) as { bal: number };
    if (bal < total) {
      throw new InsufficientStockError(m.stage, total, bal);
    }
  }

  const insert = db.prepare(
    `INSERT INTO stock_ledger
       (stage, office_id, model_id, color_id, size_id, contractor_id, staff_id,
        lot_type, lot_id, qty, ref_type, ref_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const m of movements) {
    insert.run(
      m.stage,
      m.officeId,
      m.modelId,
      m.colorId,
      m.sizeId,
      m.contractorId ?? null,
      m.staffId ?? null,
      m.lotType,
      m.lotId,
      m.qty,
      m.refType,
      m.refId,
      userId,
    );
  }
}

export type Lot = {
  lotType: LotType;
  lotId: number;
  qty: number;
  modelId: number;
  colorId: number;
  sizeId: number | null;
  contractorId: number | null;
  staffId: number | null;
  firstAt: string;
};

/** Open lots for a stage+dimension combo, FIFO order. */
export function availableLots(
  db: Db,
  filter: {
    stage: Stage;
    officeId: number;
    modelId: number;
    colorId: number;
    sizeId?: number | null;
    contractorId?: number | null;
    staffId?: number | null;
  },
): Lot[] {
  const where: string[] = ['office_id = ?', 'stage = ?', 'model_id = ?', 'color_id = ?'];
  const params: unknown[] = [filter.officeId, filter.stage, filter.modelId, filter.colorId];
  if (filter.sizeId !== undefined) {
    where.push(filter.sizeId === null ? 'size_id IS NULL' : 'size_id = ?');
    if (filter.sizeId !== null) params.push(filter.sizeId);
  }
  if (filter.contractorId !== undefined) {
    where.push(filter.contractorId === null ? 'contractor_id IS NULL' : 'contractor_id = ?');
    if (filter.contractorId !== null) params.push(filter.contractorId);
  }
  if (filter.staffId !== undefined) {
    where.push(filter.staffId === null ? 'staff_id IS NULL' : 'staff_id = ?');
    if (filter.staffId !== null) params.push(filter.staffId);
  }
  const rows = db
    .prepare(
      `SELECT lot_type, lot_id, SUM(qty) AS qty, model_id, color_id, size_id,
              contractor_id, staff_id, MIN(created_at) AS first_at
       FROM stock_ledger WHERE ${where.join(' AND ')}
       GROUP BY lot_type, lot_id HAVING SUM(qty) > 0
       ORDER BY first_at, lot_id`,
    )
    .all(...params) as Array<{
    lot_type: LotType;
    lot_id: number;
    qty: number;
    model_id: number;
    color_id: number;
    size_id: number | null;
    contractor_id: number | null;
    staff_id: number | null;
    first_at: string;
  }>;
  return rows.map((r) => ({
    lotType: r.lot_type,
    lotId: r.lot_id,
    qty: r.qty,
    modelId: r.model_id,
    colorId: r.color_id,
    sizeId: r.size_id,
    contractorId: r.contractor_id,
    staffId: r.staff_id,
    firstAt: r.first_at,
  }));
}

/**
 * Pure FIFO splitter: how much to take from which lot. Exported for unit tests.
 * Throws when the pool cannot cover the requirement.
 */
export function splitFifo(
  lots: Array<{ lotType: LotType; lotId: number; qty: number }>,
  needed: number,
): Array<{ lotType: LotType; lotId: number; qty: number }> {
  if (!Number.isInteger(needed) || needed <= 0) {
    throw new LedgerError(`FIFO requirement must be a positive integer (got ${needed}).`);
  }
  const takes: Array<{ lotType: LotType; lotId: number; qty: number }> = [];
  let remaining = needed;
  for (const lot of lots) {
    if (remaining === 0) break;
    const take = Math.min(lot.qty, remaining);
    if (take > 0) {
      takes.push({ lotType: lot.lotType, lotId: lot.lotId, qty: take });
      remaining -= take;
    }
  }
  if (remaining > 0) {
    const available = lots.reduce((s, l) => s + l.qty, 0);
    throw new InsufficientStockError('CUT', needed, available); // stage replaced by callers' messages
  }
  return takes;
}

/** Current stock grouped by dimensions for a stage (used by stock APIs/reports). */
export function stockByDimensions(
  db: Db,
  stage: Stage,
  officeId: number,
  filters: { modelId?: number; colorId?: number; sizeId?: number; contractorId?: number } = {},
): Array<Record<string, unknown>> {
  const where: string[] = ['office_id = ?', 'stage = ?'];
  const params: unknown[] = [officeId, stage];
  if (filters.modelId) {
    where.push('model_id = ?');
    params.push(filters.modelId);
  }
  if (filters.colorId) {
    where.push('color_id = ?');
    params.push(filters.colorId);
  }
  if (filters.sizeId) {
    where.push('size_id = ?');
    params.push(filters.sizeId);
  }
  if (filters.contractorId) {
    where.push('contractor_id = ?');
    params.push(filters.contractorId);
  }
  return db
    .prepare(
      `SELECT l.model_id AS modelId, m.code AS modelCode, m.name AS modelName,
              l.color_id AS colorId, c.name AS colorName,
              l.size_id AS sizeId, s.code AS sizeCode,
              l.contractor_id AS contractorId, ct.name AS contractorName,
              SUM(l.qty) AS qty
       FROM stock_ledger l
       JOIN models m ON m.id = l.model_id
       JOIN colors c ON c.id = l.color_id
       LEFT JOIN sizes s ON s.id = l.size_id
       LEFT JOIN contractors ct ON ct.id = l.contractor_id
       WHERE ${where.join(' AND ')}
       GROUP BY l.model_id, l.color_id, l.size_id, l.contractor_id
       HAVING SUM(l.qty) != 0
       ORDER BY m.code, c.name, s.sort_order`,
    )
    .all(...params) as Array<Record<string, unknown>>;
}
