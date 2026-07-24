-- 004: the v2 workflow revision (ADR-027…036).
--
--  * OFFICES: the business runs from more than one office; each office's operations are
--    fully separate (its own documents, stock and doc-number series) while masters and
--    logins are shared. office_id threads through every document + the stock ledger.
--    SQLite cannot attach a REFERENCES clause via ADD COLUMN unless the default is NULL,
--    so office_id columns are plain integers — the office middleware validates ids.
--  * CLOTH IN YARDS + WIDTH: purchases store length and width in hundredths of an inch
--    (entered as yards / inches). Legacy qty_cm/rate_paise_per_meter stay (additive-only)
--    but are no longer read.
--  * SIZE-CODE AT CUTTING: each cutting line carries its own model (auto-created from
--    the code typed on the line), so one batch can cut several codes.
--  * BUNDLES: a pack issue can be a labeled 'bundle' — checked goods kept aside to pack
--    later.

CREATE TABLE IF NOT EXISTS offices (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by INTEGER REFERENCES users(id)
);

-- Office 1 always exists: everything recorded before offices existed belongs to it,
-- and it keeps the plain (un-prefixed) document-number series.
INSERT OR IGNORE INTO offices (id, code, name) VALUES (1, 'HO', 'Main Office');

-- Operators belong to ONE office; NULL = all offices (admin / owner).
ALTER TABLE users ADD COLUMN office_id INTEGER;

ALTER TABLE purchases ADD COLUMN office_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE purchases ADD COLUMN len_inch_c INTEGER;
ALTER TABLE purchases ADD COLUMN width_inch_c INTEGER;
ALTER TABLE purchases ADD COLUMN rate_paise_per_yard INTEGER;

ALTER TABLE cutting_batches ADD COLUMN office_id INTEGER NOT NULL DEFAULT 1;
-- cloth consumed, hundredths of an inch (meters_used_cm is legacy, still written ~cm)
ALTER TABLE cutting_batches ADD COLUMN consumed_inch_c INTEGER;
-- per-line product: the code typed on the line resolves/creates this model
ALTER TABLE cutting_lines ADD COLUMN model_id INTEGER;

ALTER TABLE job_cards ADD COLUMN office_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE check_issues ADD COLUMN office_id INTEGER NOT NULL DEFAULT 1;

ALTER TABLE pack_issues ADD COLUMN office_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE pack_issues ADD COLUMN kind TEXT NOT NULL DEFAULT 'pack';
ALTER TABLE pack_issues ADD COLUMN label TEXT NOT NULL DEFAULT '';

ALTER TABLE fg_dispatches ADD COLUMN office_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE opening_balances ADD COLUMN office_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE opening_balances ADD COLUMN width_inch_c INTEGER;
ALTER TABLE contractor_payments ADD COLUMN office_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE discrepancies ADD COLUMN office_id INTEGER NOT NULL DEFAULT 1;

ALTER TABLE stock_ledger ADD COLUMN office_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_ledger_office_stage ON stock_ledger(office_id, stage);
CREATE INDEX IF NOT EXISTS idx_pack_issues_kind ON pack_issues(kind, status);
