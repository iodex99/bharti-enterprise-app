import type { Db } from '../db/connection';

/**
 * Owner dashboard (spec: Dashboard + Notifications & Alerts).
 * KPIs, chart series and alerts derived live from the ledger and documents.
 */

const DEFAULT_DELAYED_JOB_DAYS = 7;

export function delayedJobThresholdDays(db: Db): number {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'delayed_job_days'")
    .get() as { value: string } | undefined;
  const parsed = row ? Number.parseInt(row.value, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DELAYED_JOB_DAYS;
}

export function dashboardData(db: Db): Record<string, unknown> {
  const stage = (s: string) =>
    (
      db
        .prepare('SELECT COALESCE(SUM(qty),0) AS q FROM stock_ledger WHERE stage = ?')
        .get(s) as { q: number }
    ).q;

  const thresholdDays = delayedJobThresholdDays(db);

  const jobs = db
    .prepare(
      `SELECT
         COUNT(CASE WHEN status IN ('open','partially_received') THEN 1 END) AS openJobs,
         COUNT(CASE WHEN status = 'completed' THEN 1 END) AS completedJobs,
         COUNT(CASE WHEN status = 'closed_with_discrepancy' THEN 1 END) AS discrepancyJobs,
         COUNT(CASE WHEN status IN ('open','partially_received')
                     AND JULIANDAY('now') - JULIANDAY(issue_date) > ? THEN 1 END) AS delayedJobs
       FROM job_cards WHERE voided_at IS NULL`,
    )
    .get(thresholdDays) as Record<string, number>;

  const pendingReceiptsPcs = (
    db
      .prepare(
        `SELECT COALESCE(SUM(l.qty_issued_pcs - v.received_pcs - v.returned_pcs), 0) AS q
         FROM job_card_lines l
         JOIN v_job_line_status v ON v.job_card_line_id = l.id
         JOIN job_cards j ON j.id = l.job_card_id
         WHERE j.voided_at IS NULL AND j.status IN ('open','partially_received')
           AND (l.qty_issued_pcs - v.received_pcs - v.returned_pcs) > 0`,
      )
      .get() as { q: number }
  ).q;

  const unresolvedDiscrepancies = (
    db
      .prepare('SELECT COUNT(*) AS n FROM discrepancies WHERE resolved_at IS NULL')
      .get() as { n: number }
  ).n;

  const duesPaise = (
    db
      .prepare(
        `SELECT COALESCE((
           SELECT SUM(CAST(ROUND(rl.qty_pcs * l.rate_paise_per_dozen / 12.0) AS INTEGER))
           FROM job_receipt_lines rl
           JOIN job_receipts r ON r.id = rl.job_receipt_id AND r.voided_at IS NULL
           JOIN job_card_lines l ON l.id = rl.job_card_line_id
           JOIN job_cards j ON j.id = r.job_card_id AND j.voided_at IS NULL
           WHERE rl.return_type = 'stitched'
         ), 0) -
         COALESCE((SELECT SUM(amount_paise) FROM contractor_payments WHERE voided_at IS NULL), 0) AS dues`,
      )
      .get() as { dues: number }
  ).dues;

  // monthly production trend (last 6 months present in data)
  const trends = db
    .prepare(
      `WITH months AS (
         SELECT DISTINCT SUBSTR(cut_date, 1, 7) AS month FROM cutting_batches WHERE voided_at IS NULL
         UNION SELECT DISTINCT SUBSTR(receipt_date, 1, 7) FROM job_receipts WHERE voided_at IS NULL
         UNION SELECT DISTINCT SUBSTR(result_date, 1, 7) FROM pack_results
       )
       SELECT month,
         COALESCE((SELECT SUM(cl.actual_pcs) FROM cutting_lines cl
           JOIN cutting_batches cb ON cb.id = cl.cutting_batch_id
           WHERE cb.voided_at IS NULL AND SUBSTR(cb.cut_date,1,7) = month), 0) AS cutPcs,
         COALESCE((SELECT SUM(rl.qty_pcs) FROM job_receipt_lines rl
           JOIN job_receipts r ON r.id = rl.job_receipt_id
           WHERE r.voided_at IS NULL AND rl.return_type = 'stitched'
             AND SUBSTR(r.receipt_date,1,7) = month), 0) AS receivedPcs,
         COALESCE((SELECT SUM(qty_packed) FROM pack_results WHERE SUBSTR(result_date,1,7) = month), 0) AS packedPcs
       FROM months ORDER BY month DESC LIMIT 6`,
    )
    .all()
    .reverse() as Array<Record<string, unknown>>;

  const contractorBars = db
    .prepare(
      `SELECT ct.name, COALESCE(SUM(CASE WHEN rl.return_type = 'stitched' THEN rl.qty_pcs END), 0) AS receivedPcs
       FROM contractors ct
       LEFT JOIN job_cards j ON j.contractor_id = ct.id AND j.voided_at IS NULL
       LEFT JOIN job_receipts r ON r.job_card_id = j.id AND r.voided_at IS NULL
       LEFT JOIN job_receipt_lines rl ON rl.job_receipt_id = r.id
       WHERE ct.deleted_at IS NULL
       GROUP BY ct.id HAVING receivedPcs > 0
       ORDER BY receivedPcs DESC LIMIT 8`,
    )
    .all() as Array<Record<string, unknown>>;

  const rejectionReasons = db
    .prepare(
      `SELECT REPLACE(rr.reason, '_', ' ') AS reason, SUM(rr.qty_pcs) AS qtyPcs
       FROM check_result_rejections rr
       GROUP BY rr.reason ORDER BY qtyPcs DESC`,
    )
    .all() as Array<Record<string, unknown>>;

  const fgByModel = db
    .prepare(
      `SELECT m.code AS model, SUM(l.qty) AS qtyPcs
       FROM stock_ledger l JOIN models m ON m.id = l.model_id
       WHERE l.stage = 'FG'
       GROUP BY l.model_id HAVING SUM(l.qty) > 0
       ORDER BY qtyPcs DESC LIMIT 8`,
    )
    .all() as Array<Record<string, unknown>>;

  return {
    kpis: {
      rawCm: stage('RAW'),
      cutPcs: stage('CUT'),
      wipPcs: stage('WIP'),
      checkingPcs: stage('CHECKING'),
      packingPcs: stage('PACKING'),
      fgPcs: stage('FG'),
      rejectedPcs: stage('REJECTED'),
      openJobs: jobs.openJobs,
      completedJobs: jobs.completedJobs,
      delayedJobs: jobs.delayedJobs,
      pendingReceiptsPcs,
      unresolvedDiscrepancies,
      duesPaise,
      delayedThresholdDays: thresholdDays,
    },
    trends,
    contractorBars,
    rejectionReasons,
    fgByModel,
  };
}

export type Alert = {
  severity: 'info' | 'warning' | 'serious';
  title: string;
  detail: string;
  link: string;
};

export function alerts(db: Db): Alert[] {
  const out: Alert[] = [];
  const thresholdDays = delayedJobThresholdDays(db);

  const delayed = db
    .prepare(
      `SELECT j.doc_no, ct.name AS contractor,
              CAST(JULIANDAY('now') - JULIANDAY(j.issue_date) AS INTEGER) AS days
       FROM job_cards j JOIN contractors ct ON ct.id = j.contractor_id
       WHERE j.voided_at IS NULL AND j.status IN ('open','partially_received')
         AND JULIANDAY('now') - JULIANDAY(j.issue_date) > ?
       ORDER BY days DESC LIMIT 20`,
    )
    .all(thresholdDays) as Array<{ doc_no: string; contractor: string; days: number }>;
  for (const job of delayed) {
    out.push({
      severity: job.days > thresholdDays * 2 ? 'serious' : 'warning',
      title: `Job ${job.doc_no} delayed`,
      detail: `${job.contractor} has held this work ${job.days} days (limit ${thresholdDays}).`,
      link: '/jobs',
    });
  }

  const discrepancies = db
    .prepare(
      `SELECT stage, COUNT(*) AS n, SUM(ABS(qty_pcs)) AS pcs FROM discrepancies
       WHERE resolved_at IS NULL GROUP BY stage`,
    )
    .all() as Array<{ stage: string; n: number; pcs: number }>;
  for (const d of discrepancies) {
    out.push({
      severity: 'warning',
      title: `${d.n} unresolved ${d.stage} discrepanc${d.n === 1 ? 'y' : 'ies'}`,
      detail: `${d.pcs} pcs affected — review and resolve in the ${d.stage.toLowerCase()} records.`,
      link: '/reports',
    });
  }

  const checkingPool = (
    db
      .prepare(
        `SELECT COALESCE(SUM(qty),0) AS q FROM stock_ledger
         WHERE stage = 'CHECKING' AND staff_id IS NULL`,
      )
      .get() as { q: number }
  ).q;
  if (checkingPool > 0) {
    out.push({
      severity: 'info',
      title: 'Goods waiting for checking',
      detail: `${checkingPool} pcs received from contractors are not yet issued to a checker.`,
      link: '/checking',
    });
  }

  const packingPool = (
    db
      .prepare(
        `SELECT COALESCE(SUM(qty),0) AS q FROM stock_ledger
         WHERE stage = 'PACKING' AND staff_id IS NULL`,
      )
      .get() as { q: number }
  ).q;
  if (packingPool > 0) {
    out.push({
      severity: 'info',
      title: 'Goods waiting for packing',
      detail: `${packingPool} pcs passed checking but are not yet with a packer.`,
      link: '/packing',
    });
  }

  return out;
}
