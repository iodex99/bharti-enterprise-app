import type { Db } from '../db/connection';
import { contractorAnalytics } from './contractors.service';

/**
 * Report registry (spec: ~15 reports, all filterable, all Excel-exportable).
 * Each report declares typed columns shared by the on-screen table AND the xlsx
 * exporter, so screen and export can never drift.
 */

export type ColumnType = 'text' | 'date' | 'pcs' | 'cm' | 'paise' | 'pct' | 'int';

export type ReportColumn = { key: string; header: string; type: ColumnType };

export type ReportFilters = {
  from?: string;
  to?: string;
  modelId?: number;
  colorId?: number;
  sizeId?: number;
  contractorId?: number;
  staffId?: number;
  vendorId?: number;
};

export type ReportDef = {
  key: string;
  title: string;
  group: 'Inventory' | 'Production' | 'Contractors' | 'Quality' | 'Losses' | 'Management';
  description: string;
  filters: Array<keyof ReportFilters>;
  columns: ReportColumn[];
  query: (db: Db, f: ReportFilters) => Array<Record<string, unknown>>;
};

function dateClause(column: string, f: ReportFilters, where: string[], params: unknown[]): void {
  if (f.from) {
    where.push(`${column} >= ?`);
    params.push(f.from);
  }
  if (f.to) {
    where.push(`${column} <= ?`);
    params.push(f.to);
  }
}

function dimClause(
  f: ReportFilters,
  where: string[],
  params: unknown[],
  cols: Partial<Record<'model' | 'color' | 'size' | 'contractor' | 'staff' | 'vendor', string>>,
): void {
  if (f.modelId && cols.model) {
    where.push(`${cols.model} = ?`);
    params.push(f.modelId);
  }
  if (f.colorId && cols.color) {
    where.push(`${cols.color} = ?`);
    params.push(f.colorId);
  }
  if (f.sizeId && cols.size) {
    where.push(`${cols.size} = ?`);
    params.push(f.sizeId);
  }
  if (f.contractorId && cols.contractor) {
    where.push(`${cols.contractor} = ?`);
    params.push(f.contractorId);
  }
  if (f.staffId && cols.staff) {
    where.push(`${cols.staff} = ?`);
    params.push(f.staffId);
  }
  if (f.vendorId && cols.vendor) {
    where.push(`${cols.vendor} = ?`);
    params.push(f.vendorId);
  }
}

const w = (where: string[]) => (where.length ? `WHERE ${where.join(' AND ')}` : '');

export const REPORTS: ReportDef[] = [
  {
    key: 'raw-stock',
    title: 'Raw Material Stock',
    group: 'Inventory',
    description: 'Cloth on hand per batch, with vendor (raw cloth has no model until cut)',
    filters: ['colorId', 'vendorId'],
    columns: [
      { key: 'batch', header: 'Batch', type: 'text' },
      { key: 'color', header: 'Color', type: 'text' },
      { key: 'vendor', header: 'Vendor', type: 'text' },
      { key: 'receivedDate', header: 'Received', type: 'date' },
      { key: 'qtyCm', header: 'Available', type: 'cm' },
    ],
    query: (db, f) => {
      const where: string[] = ["l.stage = 'RAW'"];
      const params: unknown[] = [];
      dimClause(f, where, params, { color: 'l.color_id', vendor: 'p.vendor_id' });
      if (f.vendorId) where.push("l.lot_type = 'purchase'");
      return db
        .prepare(
          `SELECT COALESCE(p.doc_no, o.doc_no) AS batch, c.name AS color,
                  v.name AS vendor, COALESCE(p.received_date, o.balance_date) AS receivedDate,
                  SUM(l.qty) AS qtyCm
           FROM stock_ledger l
           JOIN colors c ON c.id = l.color_id
           LEFT JOIN purchases p ON l.lot_type = 'purchase' AND p.id = l.lot_id
           LEFT JOIN vendors v ON v.id = p.vendor_id
           LEFT JOIN opening_balances o ON l.lot_type = 'opening' AND o.id = l.lot_id
           ${w(where)}
           GROUP BY l.lot_type, l.lot_id HAVING SUM(l.qty) > 0
           ORDER BY c.name`,
        )
        .all(...params) as Array<Record<string, unknown>>;
    },
  },
  {
    key: 'cut-stock',
    title: 'Cut Cloth Stock',
    group: 'Inventory',
    description: 'Cut pieces ready for contractors',
    filters: ['modelId', 'colorId', 'sizeId'],
    columns: [
      { key: 'model', header: 'Model', type: 'text' },
      { key: 'color', header: 'Color', type: 'text' },
      { key: 'size', header: 'Size', type: 'text' },
      { key: 'qtyPcs', header: 'Quantity', type: 'pcs' },
    ],
    query: (db, f) => stockReport(db, f, 'CUT'),
  },
  {
    key: 'fg-stock',
    title: 'Finished Goods Stock',
    group: 'Inventory',
    description: 'Packed goods ready for sale',
    filters: ['modelId', 'colorId', 'sizeId'],
    columns: [
      { key: 'model', header: 'Model', type: 'text' },
      { key: 'color', header: 'Color', type: 'text' },
      { key: 'size', header: 'Size', type: 'text' },
      { key: 'qtyPcs', header: 'Quantity', type: 'pcs' },
    ],
    query: (db, f) => stockReport(db, f, 'FG'),
  },
  {
    key: 'inventory-aging',
    title: 'Inventory Aging',
    group: 'Management',
    description: 'How long stock has been sitting at each stage',
    filters: ['modelId', 'colorId'],
    columns: [
      { key: 'stage', header: 'Stage', type: 'text' },
      { key: 'model', header: 'Model', type: 'text' },
      { key: 'color', header: 'Color', type: 'text' },
      { key: 'size', header: 'Size', type: 'text' },
      { key: 'qty', header: 'Quantity (pcs / cm)', type: 'int' },
      { key: 'ageDays', header: 'Age (days)', type: 'int' },
    ],
    query: (db, f) => {
      const where: string[] = [];
      const params: unknown[] = [];
      dimClause(f, where, params, { model: 'l.model_id', color: 'l.color_id' });
      return db
        .prepare(
          `SELECT l.stage, m.code AS model, c.name AS color, COALESCE(s.code, '—') AS size,
                  SUM(l.qty) AS qty,
                  CAST(JULIANDAY('now') - JULIANDAY(MIN(l.created_at)) AS INTEGER) AS ageDays
           FROM stock_ledger l
           JOIN models m ON m.id = l.model_id
           JOIN colors c ON c.id = l.color_id
           LEFT JOIN sizes s ON s.id = l.size_id
           ${w(where)}
           GROUP BY l.stage, l.lot_type, l.lot_id HAVING SUM(l.qty) > 0
           ORDER BY ageDays DESC`,
        )
        .all(...params) as Array<Record<string, unknown>>;
    },
  },
  {
    key: 'cutting-variance',
    title: 'Expected vs Actual Cutting',
    group: 'Production',
    description: 'Every cutting line with its variance and reason',
    filters: ['from', 'to', 'modelId', 'colorId', 'sizeId'],
    columns: [
      { key: 'batch', header: 'Batch', type: 'text' },
      { key: 'cutDate', header: 'Date', type: 'date' },
      { key: 'model', header: 'Model', type: 'text' },
      { key: 'color', header: 'Color', type: 'text' },
      { key: 'size', header: 'Size', type: 'text' },
      { key: 'expectedPcs', header: 'Expected', type: 'pcs' },
      { key: 'actualPcs', header: 'Actual', type: 'pcs' },
      { key: 'variancePcs', header: 'Variance', type: 'pcs' },
      { key: 'variancePct', header: 'Variance %', type: 'pct' },
      { key: 'reason', header: 'Reason', type: 'text' },
    ],
    query: (db, f) => {
      const where: string[] = ["cb.status = 'completed'", 'cb.voided_at IS NULL'];
      const params: unknown[] = [];
      dateClause('cb.cut_date', f, where, params);
      dimClause(f, where, params, { model: 'cb.model_id', color: 'cb.color_id', size: 'cl.size_id' });
      return db
        .prepare(
          `SELECT cb.doc_no AS batch, cb.cut_date AS cutDate, m.code AS model, c.name AS color,
                  s.code AS size, cl.expected_pcs AS expectedPcs, cl.actual_pcs AS actualPcs,
                  cl.actual_pcs - cl.expected_pcs AS variancePcs,
                  CASE WHEN cl.expected_pcs = 0 THEN 100.0
                       ELSE ROUND((cl.actual_pcs - cl.expected_pcs) * 100.0 / cl.expected_pcs, 1) END AS variancePct,
                  COALESCE(cl.variance_reason, '') AS reason
           FROM cutting_lines cl
           JOIN cutting_batches cb ON cb.id = cl.cutting_batch_id
           JOIN models m ON m.id = cb.model_id
           JOIN colors c ON c.id = cb.color_id
           JOIN sizes s ON s.id = cl.size_id
           ${w(where)}
           ORDER BY cb.id DESC`,
        )
        .all(...params) as Array<Record<string, unknown>>;
    },
  },
  {
    key: 'production-efficiency',
    title: 'Production Efficiency',
    group: 'Production',
    description: 'Cloth used vs pieces produced per model',
    filters: ['from', 'to', 'modelId'],
    columns: [
      { key: 'model', header: 'Model', type: 'text' },
      { key: 'batches', header: 'Cutting batches', type: 'int' },
      { key: 'metersUsedCm', header: 'Cloth used', type: 'cm' },
      { key: 'piecesCut', header: 'Pieces cut', type: 'pcs' },
      { key: 'pcsPerMeter', header: 'Pieces per meter', type: 'pct' },
    ],
    query: (db, f) => {
      const where: string[] = ["cb.status = 'completed'", 'cb.voided_at IS NULL'];
      const params: unknown[] = [];
      dateClause('cb.cut_date', f, where, params);
      dimClause(f, where, params, { model: 'cb.model_id' });
      return db
        .prepare(
          `SELECT m.code AS model, COUNT(cb.id) AS batches,
                  SUM(cb.meters_used_cm) AS metersUsedCm,
                  SUM((SELECT COALESCE(SUM(cl.actual_pcs), 0) FROM cutting_lines cl
                       WHERE cl.cutting_batch_id = cb.id)) AS piecesCut,
                  ROUND(SUM((SELECT COALESCE(SUM(cl.actual_pcs), 0) FROM cutting_lines cl
                             WHERE cl.cutting_batch_id = cb.id)) * 100.0 /
                        NULLIF(SUM(cb.meters_used_cm), 0), 2) AS pcsPerMeter
           FROM cutting_batches cb
           JOIN models m ON m.id = cb.model_id
           ${w(where)}
           GROUP BY cb.model_id
           ORDER BY m.code`,
        )
        .all(...params) as Array<Record<string, unknown>>;
    },
  },
  {
    key: 'contractor-issued',
    title: 'Work Issued to Contractors',
    group: 'Contractors',
    description: 'Every job line issued in the period',
    filters: ['from', 'to', 'contractorId', 'modelId', 'sizeId'],
    columns: [
      { key: 'job', header: 'Job', type: 'text' },
      { key: 'issueDate', header: 'Issued', type: 'date' },
      { key: 'contractor', header: 'Contractor', type: 'text' },
      { key: 'model', header: 'Model', type: 'text' },
      { key: 'color', header: 'Color', type: 'text' },
      { key: 'size', header: 'Size', type: 'text' },
      { key: 'qtyPcs', header: 'Issued', type: 'pcs' },
      { key: 'ratePaise', header: 'Rate/dz', type: 'paise' },
    ],
    query: (db, f) => {
      const where: string[] = ['j.voided_at IS NULL'];
      const params: unknown[] = [];
      dateClause('j.issue_date', f, where, params);
      dimClause(f, where, params, { contractor: 'j.contractor_id', model: 'j.model_id', size: 'l.size_id' });
      return db
        .prepare(
          `SELECT j.doc_no AS job, j.issue_date AS issueDate, ct.name AS contractor,
                  m.code AS model, c.name AS color, s.code AS size,
                  l.qty_issued_pcs AS qtyPcs, l.rate_paise_per_dozen AS ratePaise
           FROM job_card_lines l
           JOIN job_cards j ON j.id = l.job_card_id
           JOIN contractors ct ON ct.id = j.contractor_id
           JOIN models m ON m.id = j.model_id
           JOIN colors c ON c.id = j.color_id
           JOIN sizes s ON s.id = l.size_id
           ${w(where)}
           ORDER BY j.id DESC`,
        )
        .all(...params) as Array<Record<string, unknown>>;
    },
  },
  {
    key: 'contractor-received',
    title: 'Work Received from Contractors',
    group: 'Contractors',
    description: 'Every receipt line in the period',
    filters: ['from', 'to', 'contractorId', 'modelId'],
    columns: [
      { key: 'receipt', header: 'Receipt', type: 'text' },
      { key: 'receiptDate', header: 'Date', type: 'date' },
      { key: 'job', header: 'Job', type: 'text' },
      { key: 'contractor', header: 'Contractor', type: 'text' },
      { key: 'size', header: 'Size', type: 'text' },
      { key: 'qtyPcs', header: 'Received', type: 'pcs' },
      { key: 'returnType', header: 'Type', type: 'text' },
    ],
    query: (db, f) => {
      const where: string[] = ['r.voided_at IS NULL', 'j.voided_at IS NULL'];
      const params: unknown[] = [];
      dateClause('r.receipt_date', f, where, params);
      dimClause(f, where, params, { contractor: 'j.contractor_id', model: 'j.model_id' });
      return db
        .prepare(
          `SELECT r.doc_no AS receipt, r.receipt_date AS receiptDate, j.doc_no AS job,
                  ct.name AS contractor, s.code AS size, rl.qty_pcs AS qtyPcs,
                  REPLACE(rl.return_type, '_', ' ') AS returnType
           FROM job_receipt_lines rl
           JOIN job_receipts r ON r.id = rl.job_receipt_id
           JOIN job_card_lines l ON l.id = rl.job_card_line_id
           JOIN job_cards j ON j.id = r.job_card_id
           JOIN contractors ct ON ct.id = j.contractor_id
           JOIN sizes s ON s.id = l.size_id
           ${w(where)}
           ORDER BY r.id DESC`,
        )
        .all(...params) as Array<Record<string, unknown>>;
    },
  },
  {
    key: 'contractor-pending',
    title: 'Pending Work with Contractors',
    group: 'Contractors',
    description: 'Open job lines with quantity still out and days since issue',
    filters: ['contractorId', 'modelId'],
    columns: [
      { key: 'job', header: 'Job', type: 'text' },
      { key: 'issueDate', header: 'Issued', type: 'date' },
      { key: 'contractor', header: 'Contractor', type: 'text' },
      { key: 'model', header: 'Model', type: 'text' },
      { key: 'size', header: 'Size', type: 'text' },
      { key: 'issuedPcs', header: 'Issued', type: 'pcs' },
      { key: 'pendingPcs', header: 'Pending', type: 'pcs' },
      { key: 'ageDays', header: 'Days out', type: 'int' },
    ],
    query: (db, f) => {
      const where: string[] = [
        'j.voided_at IS NULL',
        "j.status IN ('open','partially_received')",
      ];
      const params: unknown[] = [];
      dimClause(f, where, params, { contractor: 'j.contractor_id', model: 'j.model_id' });
      where.push('(l.qty_issued_pcs - v.received_pcs - v.returned_pcs) > 0');
      return db
        .prepare(
          `SELECT j.doc_no AS job, j.issue_date AS issueDate, ct.name AS contractor,
                  m.code AS model, s.code AS size, l.qty_issued_pcs AS issuedPcs,
                  l.qty_issued_pcs - v.received_pcs - v.returned_pcs AS pendingPcs,
                  CAST(JULIANDAY('now') - JULIANDAY(j.issue_date) AS INTEGER) AS ageDays
           FROM job_card_lines l
           JOIN v_job_line_status v ON v.job_card_line_id = l.id
           JOIN job_cards j ON j.id = l.job_card_id
           JOIN contractors ct ON ct.id = j.contractor_id
           JOIN models m ON m.id = j.model_id
           JOIN sizes s ON s.id = l.size_id
           ${w(where)}
           ORDER BY ageDays DESC`,
        )
        .all(...params) as Array<Record<string, unknown>>;
    },
  },
  {
    key: 'contractor-discrepancies',
    title: 'Contractor Discrepancy Analysis',
    group: 'Contractors',
    description: 'Shortages and excesses per contractor with reasons',
    filters: ['from', 'to', 'contractorId'],
    columns: [
      { key: 'date', header: 'Recorded', type: 'date' },
      { key: 'contractor', header: 'Contractor', type: 'text' },
      { key: 'job', header: 'Job', type: 'text' },
      { key: 'qtyPcs', header: 'Qty (−short / +excess)', type: 'pcs' },
      { key: 'reason', header: 'Reason', type: 'text' },
      { key: 'note', header: 'Note', type: 'text' },
    ],
    query: (db, f) => {
      const where: string[] = ["d.ref_type = 'job_card_line'"];
      const params: unknown[] = [];
      dateClause('DATE(d.created_at)', f, where, params);
      dimClause(f, where, params, { contractor: 'j.contractor_id' });
      return db
        .prepare(
          `SELECT DATE(d.created_at) AS date, ct.name AS contractor, j.doc_no AS job,
                  d.qty_pcs AS qtyPcs, d.reason, d.note
           FROM discrepancies d
           JOIN job_card_lines l ON l.id = d.ref_id
           JOIN job_cards j ON j.id = l.job_card_id
           JOIN contractors ct ON ct.id = j.contractor_id
           ${w(where)}
           ORDER BY d.id DESC`,
        )
        .all(...params) as Array<Record<string, unknown>>;
    },
  },
  {
    key: 'checker-performance',
    title: 'Checker Performance',
    group: 'Quality',
    description: 'Pass/reject/missing rates per checker',
    filters: ['from', 'to', 'staffId'],
    columns: [
      { key: 'checker', header: 'Checker', type: 'text' },
      { key: 'issues', header: 'Batches', type: 'int' },
      { key: 'checkedPcs', header: 'Checked', type: 'pcs' },
      { key: 'passedPcs', header: 'Passed', type: 'pcs' },
      { key: 'rejectedPcs', header: 'Rejected', type: 'pcs' },
      { key: 'missingPcs', header: 'Missing', type: 'pcs' },
      { key: 'rejectPct', header: 'Reject %', type: 'pct' },
    ],
    query: (db, f) => {
      const where: string[] = ['ci.voided_at IS NULL'];
      const params: unknown[] = [];
      dateClause('cr.result_date', f, where, params);
      dimClause(f, where, params, { staff: 'ci.staff_id' });
      return db
        .prepare(
          `SELECT st.name AS checker, COUNT(DISTINCT ci.id) AS issues,
                  SUM(cr.qty_passed + cr.qty_rejected + cr.qty_missing) AS checkedPcs,
                  SUM(cr.qty_passed) AS passedPcs, SUM(cr.qty_rejected) AS rejectedPcs,
                  SUM(cr.qty_missing) AS missingPcs,
                  ROUND(SUM(cr.qty_rejected) * 100.0 /
                        NULLIF(SUM(cr.qty_passed + cr.qty_rejected + cr.qty_missing), 0), 1) AS rejectPct
           FROM check_results cr
           JOIN check_issues ci ON ci.id = cr.check_issue_id
           JOIN staff st ON st.id = ci.staff_id
           ${w(where)}
           GROUP BY ci.staff_id ORDER BY checkedPcs DESC`,
        )
        .all(...params) as Array<Record<string, unknown>>;
    },
  },
  {
    key: 'rejection-analysis',
    title: 'Rejection Analysis',
    group: 'Quality',
    description: 'Why pieces fail checking',
    filters: ['from', 'to', 'modelId'],
    columns: [
      { key: 'reason', header: 'Reason', type: 'text' },
      { key: 'qtyPcs', header: 'Rejected', type: 'pcs' },
      { key: 'sharePct', header: 'Share %', type: 'pct' },
    ],
    query: (db, f) => {
      const where: string[] = [];
      const params: unknown[] = [];
      dateClause('cr.result_date', f, where, params);
      dimClause(f, where, params, { model: 'ci.model_id' });
      return db
        .prepare(
          `SELECT REPLACE(rr.reason, '_', ' ') AS reason, SUM(rr.qty_pcs) AS qtyPcs,
                  ROUND(SUM(rr.qty_pcs) * 100.0 / (SELECT NULLIF(SUM(rr2.qty_pcs),0)
                    FROM check_result_rejections rr2
                    JOIN check_results cr2 ON cr2.id = rr2.check_result_id
                    JOIN check_issues ci2 ON ci2.id = cr2.check_issue_id), 1) AS sharePct
           FROM check_result_rejections rr
           JOIN check_results cr ON cr.id = rr.check_result_id
           JOIN check_issues ci ON ci.id = cr.check_issue_id
           ${w(where)}
           GROUP BY rr.reason ORDER BY qtyPcs DESC`,
        )
        .all(...params) as Array<Record<string, unknown>>;
    },
  },
  {
    key: 'losses',
    title: 'Loss & Wastage (all stages)',
    group: 'Losses',
    description: 'Every recorded loss: cutting variance, contractor shortage, checking, packing',
    filters: ['from', 'to'],
    columns: [
      { key: 'date', header: 'Date', type: 'date' },
      { key: 'stage', header: 'Stage', type: 'text' },
      { key: 'reference', header: 'Reference', type: 'text' },
      { key: 'qtyPcs', header: 'Qty (− is loss)', type: 'pcs' },
      { key: 'reason', header: 'Reason', type: 'text' },
      { key: 'note', header: 'Note', type: 'text' },
    ],
    query: (db, f) => {
      const where: string[] = [];
      const params: unknown[] = [];
      dateClause('DATE(d.created_at)', f, where, params);
      return db
        .prepare(
          `SELECT DATE(d.created_at) AS date, d.stage, d.ref_type || ' #' || d.ref_id AS reference,
                  d.qty_pcs AS qtyPcs, REPLACE(d.reason, '_', ' ') AS reason, d.note
           FROM discrepancies d
           ${w(where)}
           ORDER BY d.id DESC`,
        )
        .all(...params) as Array<Record<string, unknown>>;
    },
  },
  {
    key: 'contractor-performance',
    title: 'Contractor Performance Ranking',
    group: 'Management',
    description: 'All-time contractor comparison (also on the Contractors page)',
    filters: [],
    columns: [
      { key: 'contractor', header: 'Contractor', type: 'text' },
      { key: 'totalJobs', header: 'Jobs', type: 'int' },
      { key: 'issuedPcs', header: 'Issued', type: 'pcs' },
      { key: 'receivedPcs', header: 'Received', type: 'pcs' },
      { key: 'shortagePcs', header: 'Shortage', type: 'pcs' },
      { key: 'excessPcs', header: 'Excess', type: 'pcs' },
      { key: 'discrepancyPct', header: 'Discrepancy %', type: 'pct' },
      { key: 'avgTurnaroundDays', header: 'Avg days', type: 'int' },
      { key: 'jobWorkCostPaise', header: 'Job-work cost', type: 'paise' },
      { key: 'duesPaise', header: 'Dues', type: 'paise' },
    ],
    query: (db) => {
      return contractorAnalytics(db).map((c) => ({
        contractor: c.name,
        totalJobs: c.totalJobs,
        issuedPcs: c.issuedPcs,
        receivedPcs: c.receivedPcs,
        shortagePcs: c.shortagePcs,
        excessPcs: c.excessPcs,
        discrepancyPct: c.discrepancyPct,
        avgTurnaroundDays: c.avgTurnaroundDays,
        jobWorkCostPaise: c.jobWorkCostPaise,
        duesPaise: c.duesPaise,
      }));
    },
  },
  {
    key: 'production-trends',
    title: 'Production Trends (monthly)',
    group: 'Management',
    description: 'Purchased, cut, received, packed and dispatched per month',
    filters: [],
    columns: [
      { key: 'month', header: 'Month', type: 'text' },
      { key: 'purchasedCm', header: 'Cloth purchased', type: 'cm' },
      { key: 'cutPcs', header: 'Pieces cut', type: 'pcs' },
      { key: 'receivedPcs', header: 'Stitched received', type: 'pcs' },
      { key: 'packedPcs', header: 'Packed', type: 'pcs' },
      { key: 'dispatchedPcs', header: 'Dispatched', type: 'pcs' },
    ],
    query: (db) =>
      db
        .prepare(
          `WITH months AS (
             SELECT DISTINCT SUBSTR(purchase_date, 1, 7) AS month FROM purchases WHERE voided_at IS NULL
             UNION SELECT DISTINCT SUBSTR(cut_date, 1, 7) FROM cutting_batches WHERE voided_at IS NULL
             UNION SELECT DISTINCT SUBSTR(receipt_date, 1, 7) FROM job_receipts WHERE voided_at IS NULL
             UNION SELECT DISTINCT SUBSTR(result_date, 1, 7) FROM pack_results
             UNION SELECT DISTINCT SUBSTR(dispatch_date, 1, 7) FROM fg_dispatches WHERE voided_at IS NULL
           )
           SELECT month,
             COALESCE((SELECT SUM(qty_cm) FROM purchases WHERE voided_at IS NULL AND SUBSTR(purchase_date,1,7) = month), 0) AS purchasedCm,
             COALESCE((SELECT SUM(cl.actual_pcs) FROM cutting_lines cl JOIN cutting_batches cb ON cb.id = cl.cutting_batch_id
               WHERE cb.voided_at IS NULL AND SUBSTR(cb.cut_date,1,7) = month), 0) AS cutPcs,
             COALESCE((SELECT SUM(rl.qty_pcs) FROM job_receipt_lines rl JOIN job_receipts r ON r.id = rl.job_receipt_id
               WHERE r.voided_at IS NULL AND rl.return_type = 'stitched' AND SUBSTR(r.receipt_date,1,7) = month), 0) AS receivedPcs,
             COALESCE((SELECT SUM(qty_packed) FROM pack_results WHERE SUBSTR(result_date,1,7) = month), 0) AS packedPcs,
             COALESCE((SELECT SUM(qty_pcs) FROM fg_dispatches WHERE voided_at IS NULL AND SUBSTR(dispatch_date,1,7) = month), 0) AS dispatchedPcs
           FROM months ORDER BY month DESC`,
        )
        .all() as Array<Record<string, unknown>>,
  },
];

function stockReport(db: Db, f: ReportFilters, stage: string): Array<Record<string, unknown>> {
  const where: string[] = ['l.stage = ?'];
  const params: unknown[] = [stage];
  dimClause(f, where, params, { model: 'l.model_id', color: 'l.color_id', size: 'l.size_id' });
  return db
    .prepare(
      `SELECT m.code AS model, c.name AS color, s.code AS size, SUM(l.qty) AS qtyPcs
       FROM stock_ledger l
       JOIN models m ON m.id = l.model_id
       JOIN colors c ON c.id = l.color_id
       JOIN sizes s ON s.id = l.size_id
       ${w(where)}
       GROUP BY l.model_id, l.color_id, l.size_id HAVING SUM(l.qty) != 0
       ORDER BY m.code, c.name, s.sort_order`,
    )
    .all(...params) as Array<Record<string, unknown>>;
}

export function getReport(key: string): ReportDef | undefined {
  return REPORTS.find((r) => r.key === key);
}
