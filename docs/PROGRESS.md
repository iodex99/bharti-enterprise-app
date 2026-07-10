# Progress

> **Read this first in a new session.** It is the single source of truth for where the
> build stands. Update it at every phase gate and whenever direction changes.

## Phase checklist

- [x] **Phase 0 — Scaffold**: monorepo (server/client/shared), TS strict, eslint/prettier,
  Vitest + Playwright wiring, Express serves Vite build, docs tree, CI skeleton, first push.
- [x] **Phase 1 — Deploy + self-update rails**: release.yml (windows-latest → GitHub Release
  zip + checksums), supervisor.cjs (exit-42/43 protocol, health gate, crash-loop rollback,
  DB backup/restore, release pruning), WinSW config + install-service.ps1, update
  banner/status UI, scripts/update-drill.mjs (boot → one-click update → poisoned-release
  auto-rollback, all against a mock GitHub feed). **Repo is PRIVATE** → update polling uses
  an optional PAT (supervisor config.json `githubToken` → env BHARTI_GITHUB_TOKEN; API asset
  URLs + octet-stream for downloads).
- [x] **Phase 2 — DB core**: 001_init.sql full schema (all modules), transactional
  additive-only migration runner (boot-time, pre-migrate backup, exit 43 on failure),
  sessions auth (httpOnly cookie, sliding 12h, lockout, rate limit), RBAC middleware +
  exhaustive matrix test, audit service, users admin (create/edit/deactivate/reset with
  instant session revocation), backups (daily 2AM IST cron + manual + download UI),
  audit log UI, seed script, login/shell/users/audit/backups pages, E2E (auth, forced
  password change, RBAC walls, mobile + desktop).
- [x] **Phase 3 — Masters ×6**: generic masters service (audited CRUD, soft-delete blocked
  while referenced, deactivate hides from new use), admin-only mutations / all-role reads,
  image pipeline (multer→sharp→webp in data/uploads, auth-gated serving, traversal-safe),
  config-driven MastersPage ×6, DataTable + MoneyInput + ImageInput components, masters E2E.
- [x] **Phase 4 — Ledger engine**: postMovements (sync-transaction-only, genesis/terminal/
  transfer conservation rules, per-lot overdraw guard), availableLots + splitFifo +
  stockByDimensions; purchases (server-computed totals, financial-only edits, admin void
  with reversal blocked by downstream use), opening balances (all stages, admin), stock
  APIs (/summary, /raw with vendor lots, /:stage), idempotency-key middleware; purchases +
  inventory + opening-balance UI with Meters/DzPc inputs; conservation + FIFO + purchases
  test suites. **GitHub Release v1.0.1 published by CI — real pipeline verified.**
- [x] **Phase 5 — Cutting**: plan consumes a chosen RAW lot (purchase OR opening; explicit
  batch selection per spec), actuals per size with mandatory variance reasons (incl.
  better_yield) + unplanned sizes, discrepancy rows per variance, CUT stock by cutting_line
  lot, admin void (restores RAW, removes CUT, blocked once issued), cutting UI with live
  variance badges. NOTE: cutting_batches uses raw_lot_type/raw_lot_id (not purchase_id).
- [x] **Phase 6 — Job work**: job cards with per-size lines (rate snapshot, editable), FIFO
  issue across CUT lots recorded in job_allocations (lot-typed), partial receipts, excess
  receipts (genesis + mandatory reason + discrepancy row), unstitched returns back onto the
  allocated CUT lots (LIFO), auto-complete on exact settlement, admin-only
  close-with-discrepancy (job_shortage writeoff), void for unstarted jobs, contractor
  analytics (turnaround/discrepancy %/cost/dues) + payments module with voids, full UI.
- [x] **Phase 7 — Checking + Packing + FG + dispatch**: check issues FIFO from the
  CHECKING pool (allocations recorded), incremental results (passed→PACKING pool,
  rejected→REJECTED, missing→terminal + discrepancy; rejection-reason breakdown must sum),
  pack issues FIFO from PACKING pool, incremental pack results (packed→FG, short→terminal +
  reason), staff-role validation (checker/packer/both — same-person scenario), admin FG
  dispatch with void-via-ledger-replay, voids for unstarted issues, checking/packing/
  dispatch UI. FULL-CHAIN CONSERVATION TEST: genesis − terminal = on-hand, drift 0.
- [x] **Phase 8 — Traceability + reports + Excel**: trace service (FG→vendor qty-weighted
  tree via allocations incl. opening-lot ends; purchase→forward), 15-report registry with
  typed columns shared by screen + exporter, shared filter parser (date/model/color/size/
  contractor/staff/vendor), generic exceljs exporter (title, typed formats, totals row,
  frozen header) with ?format=xlsx on every report, reports UI (grouped picker, dynamic
  filters, print CSS), trace UI (expandable tree, FIFO honesty note). Reports registry
  integration-tested report-by-report + xlsx round-trip parse.
- [x] **Phase 9 — Dashboard + alerts**: /api/dashboard (stage KPIs, jobs pulse, pending
  receipts, unresolved discrepancies, contractor dues, monthly trend series, contractor
  bars, rejection reasons, FG by model) + /api/dashboard/alerts (delayed jobs w/ threshold
  from settings key delayed_job_days default 7, unresolved discrepancies, idle checking/
  packing pools); owner HomePage with KPI tiles, alerts panel (icon+label severity), and
  four Recharts charts using the validated dataviz palette (blue/aqua/yellow, ΔE 47.2;
  direct end-labels as contrast relief). Numbers asserted against the fixture ledger.
- [x] **Phase 10 — PWA + reconciliation + settings**: installable PWA (manifest, generated
  icons, hand-rolled sw.js: network-only /api and /uploads, network-first navigations,
  cache-first hashed assets — can never mask a release or serve stale data; E2E proves
  /api freshness THROUGH the active SW), admin System Health page (live conservation
  self-checks incl. corrupted-ledger detection test, version/update state, editable
  delayed_job_days with whitelist + audit).
- [x] **Phase 11 — Hardening & ship**: final full gate (212 unit/integration + 42 E2E,
  typecheck/lint/build), final update drill 13/13 (one-click update, session+data survival,
  poisoned-release auto-rollback with DB restore), security-header assertions, complete
  USER_GUIDE (per-module staff guide), DEPLOYMENT (installer, Cloudflare Tunnel, runbook,
  go-live checklist), refreshed API/DATA_MODEL/TESTING/README docs. E2E count-wait flake
  fixed (DataTable 'N of M' barrier before row counts).

## Current state

ALL PHASES COMPLETE (0–11). 212 unit/integration + 42 E2E green; drill 13/13; every
phase shipped through the real release pipeline (GitHub Releases v1.0.x). Release pipeline VERIFIED
end-to-end on GitHub (v1.0.x zips publish on every green push). Update drill 13/13 locally.

**Environment quirks discovered (don't relearn these):**
- Repo is **private** — GitHub API needs auth; office installs need a fine-grained PAT
  (Contents: read) in supervisor config.json.
- Windows: use `C:\Windows\System32\tar.exe` (bsdtar) explicitly for zips — PATH tar may be GNU tar.
- Playwright starts webServer CONCURRENTLY with globalSetup → seed inside scripts/e2e-server.mjs.
- Playwright desktop+mobile share one server/DB → per-project usernames, raised login rate limit.
- react-hooks v7 lint: no setState-in-effect-body, no refs during render — inputs use
  initialize-once + remount-per-record (key=) pattern.

## Next steps

1. Physical go-live at the office: run docs/DEPLOYMENT.md → Go-live checklist (install
   service, tunnel, masters, opening balances, drills, staff walkthrough).
2. Roadmap candidates when the owner asks: docs/ROADMAP.md (sales module, QR labels,
   WhatsApp alerts, low-stock thresholds, rework flow…).

## Session notes

- 2026-07-10: project started; plan approved; Phases 0–2 built and verified. First push done
  (CI green on GitHub). Release pipeline live: every push to main publishes v1.0.<run_number>.
