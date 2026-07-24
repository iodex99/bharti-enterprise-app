# Data Model

> Authoritative DDL: `server/src/db/migrations/001_init.sql`. This file tracks the schema
> description and MUST be updated with every migration. Migrations are additive-only,
> run transactionally at boot (pre-migrate backup; failure = exit 43 → supervisor rollback).

## Conventions

- `id INTEGER PRIMARY KEY` everywhere; `created_at` (UTC ISO) + `created_by` on every row.
- Masters: `is_active`, `deleted_at` (soft delete allowed only with zero references;
  deactivation blocks NEW use, never closing existing work).
- Documents: never deleted. Admin-only void = `voided_at/void_reason/voided_by` + reversal
  ledger rows in the same transaction; blocked if downstream consumption exists.
- Quantities: INTEGER pieces (1dz=12) or INTEGER hundredths-of-an-inch ("inch_c",
  1 yd = 3600 — ADR-029; the legacy cm columns are still written but never read).
  Money: INTEGER paise.
- Enum columns carry CHECK constraints mirroring `shared/src/enums.ts`. The CHECKs are
  frozen at table creation (additive-only migrations cannot change them) — new semantics
  must fit inside them: e.g. 'missing' is NOT allowed in check_result_rejections, so the
  service splits it into `check_results.qty_missing` (ADR-034), and pack_allocations
  cannot hold lot_type 'pack_issue', so bundle sources carry the bundle's ORIGINAL
  allocations forward (ADR-035).
- **Multi-office (migration 004, ADR-028):** `offices` table (office 1 = 'HO', created by
  the migration, cannot be deactivated) and a plain-INTEGER `office_id NOT NULL DEFAULT 1`
  on purchases, cutting_batches, job_cards, check_issues, pack_issues, fg_dispatches,
  opening_balances, contractor_payments, discrepancies and stock_ledger (SQLite cannot ADD
  COLUMN with REFERENCES + non-NULL default; the office middleware validates instead).
  `users.office_id` NULL = all offices (admin/owner), set = pinned operator. Document
  numbers for office 1 stay plain; other offices embed the office code (`BR-RM-0001`,
  counters keyed `family@officeId`), keeping the global UNIQUE on doc_no.

## Tables (planned — updated as built)

**Core:** users, sessions, audit_log, counters, settings, schema_migrations, idempotency_keys

**Masters:** colors, sizes, vendors, contractors, staff (the legacy `role` column is
ignored — any active staff member can check or pack, ADR-019). `models` is NOT a master
any more (ADR-030): it is a hidden, system-managed table populated by the codes typed at
cutting (find-or-create; ids > 1000000 after the RAW-CLOTH sentinel; latest photo wins →
`models.image_path`); pickers read `GET /api/products`. Offices are configured at
/admin/offices (see Conventions).

**Settings keys (app-managed, not migrations):** `delayed_job_days`, `cloud_backup_dir`,
`last_daily_backup_date`, `setup_complete` (first-run wizard dismissed).

**Documents:**
purchases (RM-; vendor+color+`len_inch_c`+`width_inch_c`+`rate_paise_per_yard` — NO real
model: the `RAW-CLOTH` sentinel model [id 1000000, inactive, never listed] fills the NOT
NULL column; the code is given at cutting, ADR-016/030) · cutting_batches (CUT-; consumes
a typed raw lot: `raw_lot_type ∈ purchase|opening` + `raw_lot_id`; `consumed_inch_c`
computed from line geometry; status always 'completed' — the plan IS the cutting, ADR-031;
editable/deletable while its CUT lots are fully unconsumed) + cutting_lines
(+ `model_id` per line from the typed code, `cloth_per_pc_inch_c`, `width_count` pieces
across the cloth width, `image_path` product photo; actual_pcs = expected_pcs) ·
job_cards (JOB-; ONE per code+color, ADR-033) + job_card_lines (per-size, per-line rate
snapshot = the cost set at issue) · job_receipts (RCT-; `image_path` photo of the returned
goods is REQUIRED, ADR-032) + job_receipt_lines (return_type stitched|unstitched_return;
each line is a "pending for checking" lot until a checker verifies it — ADR-018) ·
check_issues (CHK-; directed at ONE received batch via check_allocations) +
check_results (incremental sessions; `qty_missing` = the 'missing' rejection reason,
ADR-034) + check_result_rejections ·
pack_issues (PCK-; `kind ∈ pack|bundle` + `label` — a bundle is checked goods kept aside
to pack later, ADR-035) + pack_results (incremental) · discrepancies (generic: powers loss
reports + alerts; resolved_at/by/resolution_note set by the admin-only resolve workflow —
an acknowledgement, never a stock movement) · fg_dispatches (DSP-) · opening_balances
(OPB-; `width_inch_c` for RAW rows, `model_id` from a typed code otherwise) ·
contractor_payments (PAY-)

**Engine:**
- `stock_ledger` — append-only signed rows. stage ∈ RAW/CUT/WIP/CHECKING/PACKING/FG/REJECTED;
  dims: model_id, color_id, size_id (NULL for RAW), contractor_id (WIP), staff_id
  (CHECKING/PACKING issued-to; NULL = pool); lot_type+lot_id (RAW→purchase|opening,
  CUT→cutting_line|opening, WIP→job_line, CHECKING→receipt_line|opening|check_issue(staff),
  PACKING→check_issue|opening|pack_issue(staff), FG→pack_issue|opening,
  REJECTED→check_issue); qty signed ≠ 0 (inch_c for RAW, pieces otherwise);
  ref_type/ref_id; office_id (migration 004).
- Allocations (lineage, lot-typed because opening lots participate everywhere):
  `job_allocations(job_card_line_id, cut_lot_type, cut_lot_id, qty_pcs)`,
  `check_allocations(check_issue_id, checking_lot_type, checking_lot_id, qty_pcs)`,
  `pack_allocations(pack_issue_id, packing_lot_type, packing_lot_id, qty_pcs)`.
- Views: v_stock_by_stage, v_lot_balances, v_job_line_status.

## Conservation rules (tested invariants — see reconciliation.service)

- Stock created ONLY by: `opening, purchase, cutting_output, receipt_excess, adjustment_in`.
- Stock destroyed ONLY by: `cutting_consume, job_shortage, check_missing, pack_short,
  reject_writeoff, dispatch, adjustment_out`.
- All other ref_types move stock in balanced ± pairs within one transaction
  (postMovements enforces this at write time).
- No lot balance may go negative (checked inside the transaction).
- FIFO consumes lots in `created_at` order; every FIFO draw is recorded in an
  allocations table for traceability; unstitched returns restore the allocated lots LIFO.
- Voids write compensating `adjustment_in`/`adjustment_out`/`void_reversal` rows — history
  is never rewritten; dispatch voids replay the exact consumed lots from the ledger itself.

## Unit semantics per stage

| Stage | Unit | Lot identity |
|---|---|---|
| RAW | inch_c (hundredths of an inch) | purchase |
| CUT | pieces | cutting_line (model+color+size) |
| WIP | pieces | job_card_line (adds contractor dim) |
| CHECKING | pieces | job_receipt_line (pool) / staff when issued |
| PACKING | pieces | check_issue (carries checker lineage) |
| FG | pieces | pack_issue |
| REJECTED | pieces | check_issue |


## upload_files (migration 003)

Uploaded photos are rows, not files:

| column | notes |
|---|---|
| `path` | UNIQUE public identifier, `/uploads/<YYYY-MM>/<16 hex>.webp` — unchanged from the filesystem era, so `models.image_path`, `purchases.image_path` and `job_receipts.image_path` did not have to change |
| `mime`, `size_bytes` | as stored (webp after resizing) |
| `bytes` | BLOB — the image itself |
| `created_at`, `created_by` | audit trail |

Why in the database: the Android runtime has no synchronous filesystem for the server
code to read or write (ADR-024), and it makes **one file = the whole business**, which is
what backup, restore and moving to a new device depend on. Serving is a keyed lookup, so
the path-traversal surface of static file serving is gone. Restoring a backup taken before
this migration imports its `uploads/` folder into the table.
