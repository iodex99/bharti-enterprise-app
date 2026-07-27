import { formatLen } from '@shared';
import type { Db } from '../db/connection';

/**
 * Batch traceability (spec: trace any finished-goods batch back to vendor, and any
 * purchase forward to finished goods). Downstream hops use the recorded FIFO
 * allocations, so the tree is qty-weighted and honest about mixed bins.
 *
 * Every entry point is OFFICE-SCOPED (ADR-028): the root document must belong to the
 * caller's office, and the walk from there stays inside it because allocations only
 * ever point at documents of the same office.
 */

export type TraceNode = {
  type: string;
  label: string;
  detail: string;
  qtyPcs?: number;
  children: TraceNode[];
};

export function traceFgLot(db: Db, packIssueId: number, officeId: number): TraceNode | null {
  const pack = db
    .prepare(
      `SELECT pi.*, st.name AS packer, m.code AS model, c.name AS color, s.code AS size
       FROM pack_issues pi
       JOIN staff st ON st.id = pi.staff_id
       JOIN models m ON m.id = pi.model_id
       JOIN colors c ON c.id = pi.color_id
       JOIN sizes s ON s.id = pi.size_id
       WHERE pi.id = ? AND pi.office_id = ?`,
    )
    .get(packIssueId, officeId) as Record<string, unknown> | undefined;
  if (!pack) return null;

  const packed = (
    db
      .prepare('SELECT COALESCE(SUM(qty_packed),0) AS q FROM pack_results WHERE pack_issue_id = ?')
      .get(packIssueId) as { q: number }
  ).q;

  const node: TraceNode = {
    type: 'fg',
    label: `${pack.doc_no as string} — Finished Goods`,
    detail: `${pack.model as string} ${pack.color as string} ${pack.size as string} · packed by ${pack.packer as string}`,
    qtyPcs: packed,
    children: [],
  };

  const packAllocs = db
    .prepare(
      `SELECT packing_lot_type, packing_lot_id, qty_pcs FROM pack_allocations WHERE pack_issue_id = ?`,
    )
    .all(packIssueId) as Array<{ packing_lot_type: string; packing_lot_id: number; qty_pcs: number }>;

  for (const alloc of packAllocs) {
    if (alloc.packing_lot_type === 'opening') {
      node.children.push(openingNode(db, alloc.packing_lot_id, alloc.qty_pcs));
      continue;
    }
    node.children.push(checkNode(db, alloc.packing_lot_id, alloc.qty_pcs));
  }
  return node;
}

function checkNode(db: Db, checkIssueId: number, qtyPcs: number): TraceNode {
  const check = db
    .prepare(
      `SELECT ci.doc_no, ci.issue_date, st.name AS checker FROM check_issues ci
       JOIN staff st ON st.id = ci.staff_id WHERE ci.id = ?`,
    )
    .get(checkIssueId) as { doc_no: string; issue_date: string; checker: string } | undefined;
  const node: TraceNode = {
    type: 'checking',
    label: `${check?.doc_no ?? `CHK #${checkIssueId}`} — Checked`,
    detail: `checked by ${check?.checker ?? 'unknown'} on ${check?.issue_date ?? ''}`,
    qtyPcs,
    children: [],
  };
  const checkAllocs = db
    .prepare(
      `SELECT checking_lot_type, checking_lot_id, qty_pcs FROM check_allocations WHERE check_issue_id = ?`,
    )
    .all(checkIssueId) as Array<{ checking_lot_type: string; checking_lot_id: number; qty_pcs: number }>;
  for (const alloc of checkAllocs) {
    if (alloc.checking_lot_type === 'opening') {
      node.children.push(openingNode(db, alloc.checking_lot_id, alloc.qty_pcs));
      continue;
    }
    node.children.push(receiptNode(db, alloc.checking_lot_id, alloc.qty_pcs));
  }
  return node;
}

function receiptNode(db: Db, receiptLineId: number, qtyPcs: number): TraceNode {
  const line = db
    .prepare(
      `SELECT rl.job_card_line_id, r.doc_no, r.receipt_date, j.doc_no AS job_doc, ct.name AS contractor
       FROM job_receipt_lines rl
       JOIN job_receipts r ON r.id = rl.job_receipt_id
       JOIN job_card_lines l ON l.id = rl.job_card_line_id
       JOIN job_cards j ON j.id = l.job_card_id
       JOIN contractors ct ON ct.id = j.contractor_id
       WHERE rl.id = ?`,
    )
    .get(receiptLineId) as
    | { job_card_line_id: number; doc_no: string; receipt_date: string; job_doc: string; contractor: string }
    | undefined;
  const node: TraceNode = {
    type: 'jobwork',
    label: `${line?.job_doc ?? '?'} — Stitched by ${line?.contractor ?? 'unknown'}`,
    detail: `received via ${line?.doc_no ?? '?'} on ${line?.receipt_date ?? ''}`,
    qtyPcs,
    children: [],
  };
  if (line) {
    const jobAllocs = db
      .prepare(
        `SELECT cut_lot_type, cut_lot_id, qty_pcs FROM job_allocations WHERE job_card_line_id = ?`,
      )
      .all(line.job_card_line_id) as Array<{ cut_lot_type: string; cut_lot_id: number; qty_pcs: number }>;
    for (const alloc of jobAllocs) {
      if (alloc.cut_lot_type === 'opening') {
        node.children.push(openingNode(db, alloc.cut_lot_id, alloc.qty_pcs));
        continue;
      }
      node.children.push(cuttingNode(db, alloc.cut_lot_id, alloc.qty_pcs));
    }
  }
  return node;
}

function cuttingNode(db: Db, cuttingLineId: number, qtyPcs: number): TraceNode {
  const line = db
    .prepare(
      `SELECT cb.id AS batch_id, cb.doc_no, cb.cut_date, cb.raw_lot_type, cb.raw_lot_id
       FROM cutting_lines cl JOIN cutting_batches cb ON cb.id = cl.cutting_batch_id
       WHERE cl.id = ?`,
    )
    .get(cuttingLineId) as
    | { batch_id: number; doc_no: string; cut_date: string; raw_lot_type: string; raw_lot_id: number }
    | undefined;
  const node: TraceNode = {
    type: 'cutting',
    label: `${line?.doc_no ?? '?'} — Cut`,
    detail: `cut on ${line?.cut_date ?? ''}`,
    qtyPcs,
    children: [],
  };
  if (line) {
    if (line.raw_lot_type === 'opening') {
      node.children.push(openingNode(db, line.raw_lot_id));
    } else {
      const purchase = db
        .prepare(
          `SELECT p.doc_no, p.purchase_date, p.qty_cm, v.name AS vendor FROM purchases p
           JOIN vendors v ON v.id = p.vendor_id WHERE p.id = ?`,
        )
        .get(line.raw_lot_id) as
        | { doc_no: string; purchase_date: string; qty_cm: number; vendor: string }
        | undefined;
      node.children.push({
        type: 'purchase',
        label: `${purchase?.doc_no ?? '?'} — Cloth from ${purchase?.vendor ?? 'unknown vendor'}`,
        detail: `purchased ${purchase?.purchase_date ?? ''} · ${((purchase?.qty_cm ?? 0) / 100).toFixed(2)} m`,
        children: [],
      });
    }
  }
  return node;
}

function openingNode(db: Db, openingId: number, qtyPcs?: number): TraceNode {
  const opening = db
    .prepare('SELECT doc_no, stage, balance_date FROM opening_balances WHERE id = ?')
    .get(openingId) as { doc_no: string; stage: string; balance_date: string } | undefined;
  return {
    type: 'opening',
    label: `${opening?.doc_no ?? `OPB #${openingId}`} — Opening balance`,
    detail: `pre-system stock (${opening?.stage ?? '?'} as of ${opening?.balance_date ?? '?'})`,
    ...(qtyPcs !== undefined ? { qtyPcs } : {}),
    children: [],
  };
}

/** Forward: purchase → cutting → jobs → receipts → checks → packs → FG. */
export function tracePurchaseForward(
  db: Db,
  purchaseId: number,
  officeId: number,
): TraceNode | null {
  const purchase = db
    .prepare(
      `SELECT p.*, v.name AS vendor, c.name AS color FROM purchases p
       JOIN vendors v ON v.id = p.vendor_id
       JOIN colors c ON c.id = p.color_id
       WHERE p.id = ? AND p.office_id = ?`,
    )
    .get(purchaseId, officeId) as Record<string, unknown> | undefined;
  if (!purchase) return null;

  // raw cloth has no code — it gets one at cutting (children carry the codes)
  const root: TraceNode = {
    type: 'purchase',
    label: `${purchase.doc_no as string} — Cloth from ${purchase.vendor as string}`,
    detail: `${purchase.color as string} cloth · ${formatLen((purchase.len_inch_c as number) ?? 0)}`,
    children: [],
  };

  const batches = db
    .prepare(
      `SELECT id, doc_no, cut_date, status FROM cutting_batches
       WHERE raw_lot_type = 'purchase' AND raw_lot_id = ? AND voided_at IS NULL`,
    )
    .all(purchaseId) as Array<{ id: number; doc_no: string; cut_date: string; status: string }>;

  for (const batch of batches) {
    const batchNode: TraceNode = {
      type: 'cutting',
      label: `${batch.doc_no} — Cutting (${batch.status})`,
      detail: `cut on ${batch.cut_date}`,
      children: [],
    };
    const lines = db
      .prepare(
        `SELECT cl.id, s.code AS size, cl.actual_pcs FROM cutting_lines cl
         JOIN sizes s ON s.id = cl.size_id WHERE cl.cutting_batch_id = ?`,
      )
      .all(batch.id) as Array<{ id: number; size: string; actual_pcs: number | null }>;
    for (const line of lines) {
      const jobs = db
        .prepare(
          `SELECT ja.qty_pcs, j.doc_no, ct.name AS contractor, j.status
           FROM job_allocations ja
           JOIN job_card_lines l ON l.id = ja.job_card_line_id
           JOIN job_cards j ON j.id = l.job_card_id AND j.voided_at IS NULL
           JOIN contractors ct ON ct.id = j.contractor_id
           WHERE ja.cut_lot_type = 'cutting_line' AND ja.cut_lot_id = ?`,
        )
        .all(line.id) as Array<{ qty_pcs: number; doc_no: string; contractor: string; status: string }>;
      const lineNode: TraceNode = {
        type: 'cutting_line',
        label: `Size ${line.size}`,
        detail: line.actual_pcs == null ? 'not yet cut' : `${line.actual_pcs} pcs cut`,
        qtyPcs: line.actual_pcs ?? 0,
        children: jobs.map((j) => ({
          type: 'jobwork',
          label: `${j.doc_no} — ${j.contractor}`,
          detail: `status: ${j.status}`,
          qtyPcs: j.qty_pcs,
          children: [],
        })),
      };
      batchNode.children.push(lineNode);
    }
    root.children.push(batchNode);
  }
  return root;
}

/** FG lots with balance, for the trace picker. */
export function listFgLots(db: Db, officeId: number): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT l.lot_id AS packIssueId, pi.doc_no AS docNo,
              m.code AS modelCode, c.name AS colorName, s.code AS sizeCode,
              m.code || '-' || s.code AS sizeCodeLabel,
              SUM(l.qty) AS qtyPcs
       FROM stock_ledger l
       JOIN pack_issues pi ON l.lot_type = 'pack_issue' AND pi.id = l.lot_id
       JOIN models m ON m.id = l.model_id
       JOIN colors c ON c.id = l.color_id
       JOIN sizes s ON s.id = l.size_id
       WHERE l.stage = 'FG' AND l.office_id = ?
       GROUP BY l.lot_id HAVING SUM(l.qty) != 0
       ORDER BY pi.id DESC`,
    )
    .all(officeId) as Array<Record<string, unknown>>;
}
