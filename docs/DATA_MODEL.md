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
- Quantities: INTEGER pieces (1dz=12) or INTEGER cm. Money: INTEGER paise.
- Enum columns carry CHECK constraints mirroring `shared/src/enums.ts`.

## Tables (planned — updated as built)

**Core:** users, sessions, audit_log, counters, settings, schema_migrations, idempotency_keys

**Masters:** models, colors, sizes, vendors, contractors, staff

**Documents:**
purchases (RM-) · cutting_batches (CUT-; consumes a typed raw lot:
`raw_lot_type ∈ purchase|opening` + `raw_lot_id`, model/color denormalized) +
cutting_lines · job_cards (JOB-) + job_card_lines (multi-size, per-line rate snapshot) ·
job_receipts (RCT-) + job_receipt_lines (return_type stitched|unstitched_return) ·
check_issues (CHK-) + check_results (incremental sessions) + check_result_rejections ·
pack_issues (PCK-) + pack_results (incremental) · discrepancies (generic: powers loss
reports + alerts; resolved_at/by/resolution_note set by the admin-only resolve workflow —
an acknowledgement, never a stock movement) · fg_dispatches (DSP-) · opening_balances
(OPB-) · contractor_payments (PAY-)

**Engine:**
- `stock_ledger` — append-only signed rows. stage ∈ RAW/CUT/WIP/CHECKING/PACKING/FG/REJECTED;
  dims: model_id, color_id, size_id (NULL for RAW), contractor_id (WIP), staff_id
  (CHECKING/PACKING issued-to; NULL = pool); lot_type+lot_id (RAW→purchase|opening,
  CUT→cutting_line|opening, WIP→job_line, CHECKING→receipt_line|opening|check_issue(staff),
  PACKING→check_issue|opening|pack_issue(staff), FG→pack_issue|opening,
  REJECTED→check_issue); qty signed ≠ 0 (cm for RAW, pieces otherwise); ref_type/ref_id.
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
| RAW | cm | purchase |
| CUT | pieces | cutting_line (model+color+size) |
| WIP | pieces | job_card_line (adds contractor dim) |
| CHECKING | pieces | job_receipt_line (pool) / staff when issued |
| PACKING | pieces | check_issue (carries checker lineage) |
| FG | pieces | pack_issue |
| REJECTED | pieces | check_issue |
