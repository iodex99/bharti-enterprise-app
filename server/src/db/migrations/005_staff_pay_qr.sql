-- 005: checkers/packers get paid per dozen too, and payment QR codes live on the masters.
--
-- 1. staff.default_rate_paise_per_dozen — what this checker/packer is usually paid per
--    dozen. Snapshotted onto each check/pack issue (rate_paise_per_dozen) at issue time,
--    exactly like contractor rates snapshot onto job card lines.
-- 2. contractors.image_path / staff.image_path — the person's payment QR code photo,
--    shown when recording a payment.
-- 3. staff_payments — payments to checkers/packers (partial, dated), mirroring
--    contractor_payments. Staff dues = work done × rate − payments.

ALTER TABLE staff ADD COLUMN default_rate_paise_per_dozen INTEGER NOT NULL DEFAULT 0;
ALTER TABLE staff ADD COLUMN image_path TEXT;
ALTER TABLE contractors ADD COLUMN image_path TEXT;

ALTER TABLE check_issues ADD COLUMN rate_paise_per_dozen INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pack_issues ADD COLUMN rate_paise_per_dozen INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS staff_payments (
  id INTEGER PRIMARY KEY,
  doc_no TEXT NOT NULL UNIQUE,
  office_id INTEGER NOT NULL DEFAULT 1,
  staff_id INTEGER NOT NULL REFERENCES staff(id),
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
CREATE INDEX IF NOT EXISTS idx_staff_payments_staff ON staff_payments(staff_id);
CREATE INDEX IF NOT EXISTS idx_staff_payments_office ON staff_payments(office_id);
