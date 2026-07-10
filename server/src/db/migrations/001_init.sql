-- 001_init.sql — complete schema v1 for Bharti Enterprises P&I Management System.
-- Conventions: integer pieces (1dz=12) / integer cm / integer paise; UTC ISO timestamps;
-- business dates as YYYY-MM-DD strings; soft delete on masters; void-with-reversal on
-- documents; every enum column CHECK-constrained to shared/src/enums.ts vocabularies.

------------------------------------------------------------------------------
-- core
------------------------------------------------------------------------------

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','operator','owner')),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  must_change_password INTEGER NOT NULL DEFAULT 1 CHECK (must_change_password IN (0,1)),
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by INTEGER REFERENCES users(id)
);

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ip TEXT,
  revoked_at TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  old_json TEXT,
  new_json TEXT,
  ip TEXT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_at ON audit_log(at);
CREATE INDEX idx_audit_user ON audit_log(user_id);

CREATE TABLE counters (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by INTEGER REFERENCES users(id)
);

CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

------------------------------------------------------------------------------
-- masters
------------------------------------------------------------------------------

CREATE TABLE models (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  image_path TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by INTEGER REFERENCES users(id)
);

CREATE TABLE colors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color_code TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by INTEGER REFERENCES users(id)
);

CREATE TABLE sizes (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by INTEGER REFERENCES users(id)
);

CREATE TABLE vendors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  contact_person TEXT NOT NULL DEFAULT '',
  mobile TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  gstin TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by INTEGER REFERENCES users(id)
);

CREATE TABLE contractors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  contact_person TEXT NOT NULL DEFAULT '',
  mobile TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  default_rate_paise_per_dozen INTEGER NOT NULL DEFAULT 0 CHECK (default_rate_paise_per_dozen >= 0),
  notes TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by INTEGER REFERENCES users(id)
);

CREATE TABLE staff (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  mobile TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('checker','packer','both')),
  notes TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by INTEGER REFERENCES users(id)
);

------------------------------------------------------------------------------
-- documents
------------------------------------------------------------------------------

CREATE TABLE purchases (
  id INTEGER PRIMARY KEY,
  doc_no TEXT NOT NULL UNIQUE,
  purchase_date TEXT NOT NULL,
  received_date TEXT NOT NULL,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  model_id INTEGER NOT NULL REFERENCES models(id),
  color_id INTEGER NOT NULL REFERENCES colors(id),
  qty_cm INTEGER NOT NULL CHECK (qty_cm > 0),
  rate_paise_per_meter INTEGER NOT NULL CHECK (rate_paise_per_meter >= 0),
  total_paise INTEGER NOT NULL CHECK (total_paise >= 0),
  image_path TEXT,
  notes TEXT NOT NULL DEFAULT '',
  voided_at TEXT,
  void_reason TEXT,
  voided_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by INTEGER REFERENCES users(id)
);
CREATE INDEX idx_purchases_vendor ON purchases(vendor_id);
CREATE INDEX idx_purchases_model_color ON purchases(model_id, color_id);
CREATE INDEX idx_purchases_date ON purchases(purchase_date);

CREATE TABLE cutting_batches (
  id INTEGER PRIMARY KEY,
  doc_no TEXT NOT NULL UNIQUE,
  cut_date TEXT NOT NULL,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id),
  meters_used_cm INTEGER NOT NULL CHECK (meters_used_cm > 0),
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','completed')),
  completed_at TEXT,
  notes TEXT NOT NULL DEFAULT '',
  voided_at TEXT,
  void_reason TEXT,
  voided_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by INTEGER REFERENCES users(id)
);
CREATE INDEX idx_cutting_purchase ON cutting_batches(purchase_id);
CREATE INDEX idx_cutting_status ON cutting_batches(status);

CREATE TABLE cutting_lines (
  id INTEGER PRIMARY KEY,
  cutting_batch_id INTEGER NOT NULL REFERENCES cutting_batches(id),
  size_id INTEGER NOT NULL REFERENCES sizes(id),
  expected_pcs INTEGER NOT NULL DEFAULT 0 CHECK (expected_pcs >= 0),
  actual_pcs INTEGER CHECK (actual_pcs IS NULL OR actual_pcs >= 0),
  variance_reason TEXT CHECK (variance_reason IS NULL OR variance_reason IN
    ('wastage','measurement_error','production_loss','better_yield','other')),
  reason_note TEXT NOT NULL DEFAULT '',
  UNIQUE (cutting_batch_id, size_id)
);
CREATE INDEX idx_cutting_lines_batch ON cutting_lines(cutting_batch_id);

CREATE TABLE job_cards (
  id INTEGER PRIMARY KEY,
  doc_no TEXT NOT NULL UNIQUE,
  issue_date TEXT NOT NULL,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id),
  model_id INTEGER NOT NULL REFERENCES models(id),
  color_id INTEGER NOT NULL REFERENCES colors(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN
    ('open','partially_received','completed','closed_with_discrepancy')),
  closed_at TEXT,
  closed_by INTEGER REFERENCES users(id),
  close_note TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  voided_at TEXT,
  void_reason TEXT,
  voided_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by INTEGER REFERENCES users(id)
);
CREATE INDEX idx_jobs_contractor ON job_cards(contractor_id);
CREATE INDEX idx_jobs_status ON job_cards(status);
CREATE INDEX idx_jobs_issue_date ON job_cards(issue_date);

CREATE TABLE job_card_lines (
  id INTEGER PRIMARY KEY,
  job_card_id INTEGER NOT NULL REFERENCES job_cards(id),
  size_id INTEGER NOT NULL REFERENCES sizes(id),
  qty_issued_pcs INTEGER NOT NULL CHECK (qty_issued_pcs > 0),
  unit_entered TEXT NOT NULL DEFAULT 'dozens' CHECK (unit_entered IN ('dozens','pieces')),
  rate_paise_per_dozen INTEGER NOT NULL DEFAULT 0 CHECK (rate_paise_per_dozen >= 0),
  UNIQUE (job_card_id, size_id)
);
CREATE INDEX idx_job_lines_job ON job_card_lines(job_card_id);

CREATE TABLE job_receipts (
  id INTEGER PRIMARY KEY,
  doc_no TEXT NOT NULL UNIQUE,
  job_card_id INTEGER NOT NULL REFERENCES job_cards(id),
  receipt_date TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  voided_at TEXT,
  void_reason TEXT,
  voided_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by INTEGER REFERENCES users(id)
);
CREATE INDEX idx_receipts_job ON job_receipts(job_card_id);

CREATE TABLE job_receipt_lines (
  id INTEGER PRIMARY KEY,
  job_receipt_id INTEGER NOT NULL REFERENCES job_receipts(id),
  job_card_line_id INTEGER NOT NULL REFERENCES job_card_lines(id),
  qty_pcs INTEGER NOT NULL CHECK (qty_pcs > 0),
  return_type TEXT NOT NULL DEFAULT 'stitched' CHECK (return_type IN ('stitched','unstitched_return'))
);
CREATE INDEX idx_receipt_lines_receipt ON job_receipt_lines(job_receipt_id);
CREATE INDEX idx_receipt_lines_job_line ON job_receipt_lines(job_card_line_id);

CREATE TABLE check_issues (
  id INTEGER PRIMARY KEY,
  doc_no TEXT NOT NULL UNIQUE,
  issue_date TEXT NOT NULL,
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  model_id INTEGER NOT NULL REFERENCES models(id),
  color_id INTEGER NOT NULL REFERENCES colors(id),
  size_id INTEGER NOT NULL REFERENCES sizes(id),
  qty_pcs INTEGER NOT NULL CHECK (qty_pcs > 0),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed')),
  completed_at TEXT,
  notes TEXT NOT NULL DEFAULT '',
  voided_at TEXT,
  void_reason TEXT,
  voided_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by INTEGER REFERENCES users(id)
);
CREATE INDEX idx_check_issues_staff ON check_issues(staff_id);
CREATE INDEX idx_check_issues_status ON check_issues(status);

CREATE TABLE check_results (
  id INTEGER PRIMARY KEY,
  check_issue_id INTEGER NOT NULL REFERENCES check_issues(id),
  result_date TEXT NOT NULL,
  qty_passed INTEGER NOT NULL DEFAULT 0 CHECK (qty_passed >= 0),
  qty_rejected INTEGER NOT NULL DEFAULT 0 CHECK (qty_rejected >= 0),
  qty_missing INTEGER NOT NULL DEFAULT 0 CHECK (qty_missing >= 0),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by INTEGER REFERENCES users(id),
  CHECK (qty_passed + qty_rejected + qty_missing > 0)
);
CREATE INDEX idx_check_results_issue ON check_results(check_issue_id);

CREATE TABLE check_result_rejections (
  id INTEGER PRIMARY KEY,
  check_result_id INTEGER NOT NULL REFERENCES check_results(id),
  reason TEXT NOT NULL CHECK (reason IN
    ('stitching_issue','elastic_issue','color_defect','damage','other')),
  qty_pcs INTEGER NOT NULL CHECK (qty_pcs > 0)
);
CREATE INDEX idx_rejections_result ON check_result_rejections(check_result_id);

CREATE TABLE pack_issues (
  id INTEGER PRIMARY KEY,
  doc_no TEXT NOT NULL UNIQUE,
  issue_date TEXT NOT NULL,
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  model_id INTEGER NOT NULL REFERENCES models(id),
  color_id INTEGER NOT NULL REFERENCES colors(id),
  size_id INTEGER NOT NULL REFERENCES sizes(id),
  qty_pcs INTEGER NOT NULL CHECK (qty_pcs > 0),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed')),
  completed_at TEXT,
  notes TEXT NOT NULL DEFAULT '',
  voided_at TEXT,
  void_reason TEXT,
  voided_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by INTEGER REFERENCES users(id)
);
CREATE INDEX idx_pack_issues_staff ON pack_issues(staff_id);
CREATE INDEX idx_pack_issues_status ON pack_issues(status);

CREATE TABLE pack_results (
  id INTEGER PRIMARY KEY,
  pack_issue_id INTEGER NOT NULL REFERENCES pack_issues(id),
  result_date TEXT NOT NULL,
  qty_packed INTEGER NOT NULL DEFAULT 0 CHECK (qty_packed >= 0),
  qty_short INTEGER NOT NULL DEFAULT 0 CHECK (qty_short >= 0),
  short_reason TEXT CHECK (short_reason IS NULL OR short_reason IN ('damage','missing','other')),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by INTEGER REFERENCES users(id),
  CHECK (qty_packed + qty_short > 0)
);
CREATE INDEX idx_pack_results_issue ON pack_results(pack_issue_id);

CREATE TABLE discrepancies (
  id INTEGER PRIMARY KEY,
  stage TEXT NOT NULL CHECK (stage IN ('RAW','CUT','WIP','CHECKING','PACKING','FG','REJECTED')),
  ref_type TEXT NOT NULL,
  ref_id INTEGER NOT NULL,
  qty_pcs INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN
    ('wastage','damage','short_issue','missing_pieces','quality_rejection',
     'measurement_error','production_loss','better_yield','stitching_issue',
     'elastic_issue','color_defect','missing','other')),
  note TEXT NOT NULL DEFAULT '',
  resolved_at TEXT,
  resolved_by INTEGER REFERENCES users(id),
  resolution_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by INTEGER REFERENCES users(id)
);
CREATE INDEX idx_discrepancies_ref ON discrepancies(ref_type, ref_id);
CREATE INDEX idx_discrepancies_unresolved ON discrepancies(resolved_at) WHERE resolved_at IS NULL;

CREATE TABLE fg_dispatches (
  id INTEGER PRIMARY KEY,
  doc_no TEXT NOT NULL UNIQUE,
  dispatch_date TEXT NOT NULL,
  model_id INTEGER NOT NULL REFERENCES models(id),
  color_id INTEGER NOT NULL REFERENCES colors(id),
  size_id INTEGER NOT NULL REFERENCES sizes(id),
  qty_pcs INTEGER NOT NULL CHECK (qty_pcs > 0),
  notes TEXT NOT NULL DEFAULT '',
  voided_at TEXT,
  void_reason TEXT,
  voided_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by INTEGER REFERENCES users(id)
);

CREATE TABLE opening_balances (
  id INTEGER PRIMARY KEY,
  doc_no TEXT NOT NULL UNIQUE,
  balance_date TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('RAW','CUT','WIP','CHECKING','PACKING','FG','REJECTED')),
  model_id INTEGER NOT NULL REFERENCES models(id),
  color_id INTEGER NOT NULL REFERENCES colors(id),
  size_id INTEGER REFERENCES sizes(id),
  contractor_id INTEGER REFERENCES contractors(id),
  qty INTEGER NOT NULL CHECK (qty > 0),
  note TEXT NOT NULL DEFAULT '',
  voided_at TEXT,
  void_reason TEXT,
  voided_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by INTEGER REFERENCES users(id),
  CHECK (stage = 'RAW' OR size_id IS NOT NULL),
  CHECK (stage != 'WIP' OR contractor_id IS NOT NULL)
);

CREATE TABLE contractor_payments (
  id INTEGER PRIMARY KEY,
  doc_no TEXT NOT NULL UNIQUE,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id),
  payment_date TEXT NOT NULL,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  mode TEXT NOT NULL CHECK (mode IN ('cash','upi','bank_transfer','cheque','other')),
  reference TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  voided_at TEXT,
  void_reason TEXT,
  voided_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by INTEGER REFERENCES users(id)
);
CREATE INDEX idx_payments_contractor ON contractor_payments(contractor_id);

------------------------------------------------------------------------------
-- stock ledger engine
------------------------------------------------------------------------------

CREATE TABLE stock_ledger (
  id INTEGER PRIMARY KEY,
  stage TEXT NOT NULL CHECK (stage IN ('RAW','CUT','WIP','CHECKING','PACKING','FG','REJECTED')),
  model_id INTEGER NOT NULL REFERENCES models(id),
  color_id INTEGER NOT NULL REFERENCES colors(id),
  size_id INTEGER REFERENCES sizes(id),          -- NULL only for RAW
  contractor_id INTEGER REFERENCES contractors(id), -- set for WIP rows
  staff_id INTEGER REFERENCES staff(id),         -- set for CHECKING/PACKING issued-to rows
  lot_type TEXT NOT NULL,
  lot_id INTEGER NOT NULL,
  qty INTEGER NOT NULL CHECK (qty != 0),         -- +in / -out; cm for RAW, pieces otherwise
  ref_type TEXT NOT NULL CHECK (ref_type IN
    ('opening','purchase','cutting_output','receipt_excess','adjustment_in',
     'cutting_consume','check_missing','pack_short','reject_writeoff','dispatch','adjustment_out',
     'job_issue','job_receipt','unstitched_return','check_issue','check_pass','check_reject',
     'pack_issue','pack_output','void_reversal')),
  ref_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by INTEGER REFERENCES users(id),
  CHECK (stage = 'RAW' OR size_id IS NOT NULL)
);
CREATE INDEX idx_ledger_stage_dims ON stock_ledger(stage, model_id, color_id, size_id);
CREATE INDEX idx_ledger_lot ON stock_ledger(stage, lot_type, lot_id);
CREATE INDEX idx_ledger_ref ON stock_ledger(ref_type, ref_id);
CREATE INDEX idx_ledger_contractor ON stock_ledger(contractor_id) WHERE contractor_id IS NOT NULL;

-- lineage: FIFO allocations recorded at each downstream hop
CREATE TABLE job_allocations (
  id INTEGER PRIMARY KEY,
  job_card_line_id INTEGER NOT NULL REFERENCES job_card_lines(id),
  cutting_line_id INTEGER NOT NULL REFERENCES cutting_lines(id),
  qty_pcs INTEGER NOT NULL CHECK (qty_pcs > 0)
);
CREATE INDEX idx_job_alloc_line ON job_allocations(job_card_line_id);
CREATE INDEX idx_job_alloc_cutting ON job_allocations(cutting_line_id);

CREATE TABLE check_allocations (
  id INTEGER PRIMARY KEY,
  check_issue_id INTEGER NOT NULL REFERENCES check_issues(id),
  job_receipt_line_id INTEGER NOT NULL REFERENCES job_receipt_lines(id),
  qty_pcs INTEGER NOT NULL CHECK (qty_pcs > 0)
);
CREATE INDEX idx_check_alloc_issue ON check_allocations(check_issue_id);
CREATE INDEX idx_check_alloc_receipt ON check_allocations(job_receipt_line_id);

CREATE TABLE pack_allocations (
  id INTEGER PRIMARY KEY,
  pack_issue_id INTEGER NOT NULL REFERENCES pack_issues(id),
  check_issue_id INTEGER NOT NULL REFERENCES check_issues(id),
  qty_pcs INTEGER NOT NULL CHECK (qty_pcs > 0)
);
CREATE INDEX idx_pack_alloc_issue ON pack_allocations(pack_issue_id);
CREATE INDEX idx_pack_alloc_check ON pack_allocations(check_issue_id);

------------------------------------------------------------------------------
-- views
------------------------------------------------------------------------------

CREATE VIEW v_stock_by_stage AS
SELECT stage, model_id, color_id, size_id, contractor_id, SUM(qty) AS qty
FROM stock_ledger
GROUP BY stage, model_id, color_id, size_id, contractor_id
HAVING SUM(qty) != 0;

CREATE VIEW v_lot_balances AS
SELECT stage, lot_type, lot_id, model_id, color_id, size_id, contractor_id, staff_id,
       SUM(qty) AS qty, MIN(created_at) AS first_at
FROM stock_ledger
GROUP BY stage, lot_type, lot_id
HAVING SUM(qty) != 0;

CREATE VIEW v_job_line_status AS
SELECT
  l.id AS job_card_line_id,
  l.job_card_id,
  l.size_id,
  l.qty_issued_pcs,
  COALESCE((SELECT SUM(rl.qty_pcs) FROM job_receipt_lines rl
            JOIN job_receipts r ON r.id = rl.job_receipt_id AND r.voided_at IS NULL
            WHERE rl.job_card_line_id = l.id AND rl.return_type = 'stitched'), 0) AS received_pcs,
  COALESCE((SELECT SUM(rl.qty_pcs) FROM job_receipt_lines rl
            JOIN job_receipts r ON r.id = rl.job_receipt_id AND r.voided_at IS NULL
            WHERE rl.job_card_line_id = l.id AND rl.return_type = 'unstitched_return'), 0) AS returned_pcs
FROM job_card_lines l;
