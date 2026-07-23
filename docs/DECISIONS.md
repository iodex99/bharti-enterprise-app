# Decisions (ADR log)

One line per locked decision; expand only when the reasoning is non-obvious.

- **ADR-001** Stack: Node 24 + Express 5 + better-sqlite3 + React 19 + Vite + Tailwind 4.
  Single office-PC deployment → single-file DB, one port, no external services.
- **ADR-002** All quantities stored as integers: pieces (1dz=12), cm, paise. Floats banned
  from the DB; conversions centralized in `shared/src/units.ts`.
- **ADR-003** Single `stock_ledger` table for all 7 stages (not per-stage tables);
  balances via SUM; per-stage SQL views for reporting.
- **ADR-004** Server-side sessions (not JWT): single server, instant revocation on user
  deactivation; httpOnly SameSite=Lax cookie.
- **ADR-005** Self-update via supervisor + immutable side-by-side releases + CI-built
  GitHub Release zips (NOT PM2 + git pull: Windows file locks and process-tree kills make
  in-place updates unreliable). Exit code 42 = apply staged update, 43 = migration failure.
- **ADR-006** Migrations additive-only, run at boot, transactional, DB backed up first;
  enables safe automatic rollback to the previous release.
- **ADR-007** Batch lineage: explicit batch selection at cutting only; FIFO auto-allocation
  at every downstream hop (job/check/pack allocations tables). Documented as an honest
  approximation of physically mixed bins.
- **ADR-008** Raw SQL + thin typed repositories, no ORM: ledger-centric app, hand-rolled
  additive migrations.
- **ADR-009** Requests validated with zod schemas shared between server and client
  (`@shared` path alias; no build step for the shared folder).
- **ADR-010** Business dates are user-entered `YYYY-MM-DD` strings (backdating allowed,
  reports filter on them); `created_at` UTC ISO timestamps are the audit truth.
- **ADR-011** Minimal FG dispatch (admin-only stock-out) ships in v1 so finished-goods
  inventory can decrease; the full sales module stays on the roadmap.
- **ADR-012** Supervisor is CommonJS (`supervisor.cjs`), zero npm dependencies, installed
  once, never auto-updated — it must survive any app-release bug.
- **ADR-013** Resolving a discrepancy is an acknowledgement (admin-only note + who/when),
  NEVER a stock movement — the ledger effect already happened when the difference was
  recorded. Keeps the review workflow unable to corrupt inventory.
- **ADR-014** A "complete backup" is a single `.zip` (database + uploads/ + manifest),
  built/read with `adm-zip` (pure-JS, no native ABI concerns). Manifest carries the app
  version + applied migrations so restore can refuse a backup from a NEWER app (additive
  migrations are forward-only). This is the migration unit.
- **ADR-015** In-app restore reuses the demo-mode runtime connection swap (close → replace
  files → reopen), but runs the swap FULLY SYNCHRONOUSLY so no request can observe a
  half-swapped data dir — no supervisor/exit-code involvement. The pre-restore state is
  moved aside first and restored automatically on any failure; sessions are cleared so
  everyone re-authenticates against the restored data. Restore/complete-backup are refused
  in demo mode (they must act on real data).
- **ADR-016** The MODEL is decided at CUTTING, not at purchase (cloth is bought as
  vendor + color + meters). Because purchases/stock_ledger model columns are NOT NULL and
  migrations are additive-only, an inactive sentinel model `RAW-CLOTH` (pinned id 1000000)
  fills them; it is excluded from all listings/dropdowns and RAW displays show color+vendor
  only. Cutting takes `modelId` in its input; RAW ledger rows always use the LOT's stored
  model so lot balances never split across dimensions.
- **ADR-017** Cutting consumption is COMPUTED, not typed: each plan line carries cloth per
  piece in integer HUNDREDTHS OF AN INCH plus a width count (pieces cut side-by-side);
  `clothRequiredCm` (shared) = ceil(strips × length × 2.54), strips = ceil(pcs/width),
  rounded UP because cut cloth is gone. Consumption stays plan-based at actuals time.
- **ADR-018** Checking is DIRECTED, not FIFO: goods a contractor claims to have returned
  sit in "pending for checking" per receipt line, and a check issue names the specific
  batch (contractor ↔ checker mapping is explicit). check_allocations keeps recording the
  (single) take so traceability is unchanged; missing/reject discrepancies are attributed
  to checker AND source contractor. Receipts can carry a photo for reference at checking.
- **ADR-019** Staff have NO fixed checker/packer role — any active staff member can be
  picked for either task. The legacy `role` column stays (additive-only) but is ignored;
  new staff default to 'both'.
- **ADR-020** Register ink convention carried into the UI: BLUE numbers = goods issued
  OUT (job issue, to checker/packer, dispatch), RED numbers = goods received IN
  (purchases, contractor returns) — matching the paper registers the staff already read.
