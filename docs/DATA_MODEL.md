# Data Model

> Full DDL lands in Phase 2 (`server/src/db/migrations/001_init.sql`). This file tracks the
> authoritative schema description and MUST be updated with every migration.

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
purchases (RM-) · cutting_batches (CUT-) + cutting_lines · job_cards (JOB-) +
job_card_lines · job_receipts (RCT-) + job_receipt_lines · check_issues (CHK-) +
check_results + check_result_rejections · pack_issues (PCK-) + pack_results ·
discrepancies · fg_dispatches (DSP-) · opening_balances (OPB-) · contractor_payments (PAY-)

**Engine:**
- `stock_ledger` — append-only signed rows. stage ∈ RAW/CUT/WIP/CHECKING/PACKING/FG/REJECTED;
  dims: model_id, color_id, size_id (NULL for RAW), contractor_id (WIP), staff_id;
  lot_type+lot_id (RAW→purchase, CUT→cutting_line, WIP→job_line, CHECKING→receipt_line,
  PACKING→check_issue, FG→pack_issue); qty signed ≠ 0; ref_type/ref_id.
- Allocations (lineage): job_allocations, check_allocations, pack_allocations.
- Views: v_stock_* per stage, v_lot_balances, v_job_line_status.

## Conservation rules (tested invariants)

- Stock created ONLY by: `opening, purchase, cutting_output, receipt_excess, adjustment_in`.
- Stock destroyed ONLY by: `cutting_consume, check_missing, pack_short, reject_writeoff,
  dispatch, adjustment_out`.
- All other ref_types move stock in balanced ± pairs within one transaction.
- No lot balance may go negative (checked inside the transaction).
- FIFO consumes lots in `created_at` order.

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
