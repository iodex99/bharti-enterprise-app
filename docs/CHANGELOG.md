# Changelog

Newest first. Every meaningful change gets a line. CI release notes are generated from
commit messages; this file is the human-curated history.

## Unreleased

- 2026-07-11 — Cloud backups, Complete Business Report, filters everywhere: backups now
  mirror automatically into a Google Drive/OneDrive-synced folder (set on the Backups
  page; owner signs into Drive for Desktop once — no API keys); a Complete Business
  Report bundles every report + KPIs + charts into a styled HTML document or a
  multi-sheet Excel workbook with date range; every list gained dropdown filters,
  a date-range filter and click-to-sort column headers.

- 2026-07-11 — In-app demo mode: Admin → System Health buttons to enter/exit/rebuild/
  remove a physically separate demo database (runtime connection switch; sessions,
  uploads and backups all follow the active database; DEMO banner app-wide; login-page
  hint; audited in the real DB). Deployment guide rewritten for no-domain remote access
  (Tailscale with HTTPS via tailscale serve as the primary path).

- 2026-07-11 — Demo mode + hardening: `npm run seed:demo` builds a fully separate demo
  database (data-demo/) with ~3 months of realistic business driven through the service
  layer and verified by the reconciliation checks; `npm run dev:demo` runs against it;
  deleting the folder removes the demo. Edge-case fixes: non-numeric ids in URLs now 404
  (were 500), unknown foreign keys and malformed JSON now return clean 400s, opening
  balances and job cards validate active masters. 22 new hostile-input tests.

- 2026-07-11 — Phase 11: complete staff USER_GUIDE, office DEPLOYMENT guide (installer,
  Cloudflare Tunnel, runbook, go-live checklist), final API/data-model/testing docs,
  security-header assertions; final full verification (unit+integration+E2E) and update
  drill re-run before release.

- 2026-07-11 — Phase 10: installable phone app (PWA) with an update-safe service worker,
  admin System Health panel with live inventory self-checks (conservation re-derived on
  demand), configurable delayed-job threshold.

- 2026-07-11 — Phase 9: owner dashboard — live KPI tiles for all seven stock stages and
  business pulse (open/delayed jobs, pending receipts, unresolved discrepancies, contractor
  dues), alerts panel (delayed jobs, discrepancies, idle checking/packing goods), and four
  charts (production trend, contractor deliveries, rejection reasons, finished goods by
  model) with a colorblind-validated palette.

- 2026-07-11 — Phase 8: batch traceability (finished goods traced back through packer,
  checker, contractor, cutting batch to the cloth purchase and vendor; purchases traced
  forward), 15 filterable reports across inventory/production/contractors/quality/losses/
  management, one-click Excel export on every report (typed columns, totals, Indian
  formats), print view.

- 2026-07-11 — Phase 7: checking (issue to checker, incremental pass/reject/missing results
  with reason breakdowns, REJECTED stage), packing (issue to packer, packed→finished goods,
  shortages with reasons), same-person checker+packer support, admin FG dispatches with
  safe voids, full-chain conservation test proving zero inventory drift from purchase to
  finished goods.

- 2026-07-11 — Phase 6: contractor job work — multi-size job cards with auto-fetched
  editable rates, FIFO issue with recorded allocations, partial receipts (10dz as 2+3+5),
  excess receipts with mandatory reasons, unstitched cloth returns, auto-completion on
  exact match, admin-only discrepancy close with shortage write-off, contractor performance
  analytics (rankings, turnaround, discrepancy %) and payments ledger with dues tracking.

- 2026-07-10 — Phase 5: cutting module — plans consume a selected cloth batch (purchase or
  opening lot) with availability checks; actuals per size enforce variance reasons and allow
  unplanned sizes; CUT inventory tracked per cutting line; variance discrepancies recorded;
  admin void with full stock restore; cutting UI with live variance calculation.

- 2026-07-10 — Phase 4: stock ledger engine (conservation rules enforced at write time:
  genesis/terminal whitelists, balanced transfers, per-lot overdraw rejection, sync-
  transaction-only), purchases module (RM- batches, server-computed totals, financial-only
  edits, admin void with ledger reversal blocked by downstream use, idempotency keys),
  opening balances for go-live stock (all 7 stages), inventory views (summary + per-stage +
  RAW by vendor/lot), purchases & opening-balance & inventory UI, Meters/DzPc inputs.
  First real GitHub Release (v1.0.1) published by the pipeline.

- 2026-07-10 — Phase 3: all six masters (generic audited CRUD service; unique-name/code
  409s; soft delete blocked while referenced with "deactivate instead" guidance; admin-only
  mutations, all roles read), image upload pipeline (sharp → webp 1600px, EXIF stripped,
  auth-gated /uploads serving, traversal-safe), config-driven masters UI with DataTable,
  MoneyInput (₹→paise), ImageInput; masters integration suite + E2E. Update drill upgraded
  for the auth era and passing 13/13 incl. session survival across updates.

- 2026-07-10 — Phase 2: complete schema v1 (masters, documents, stock_ledger, allocations,
  audit, sessions), boot-time transactional migrations with pre-migrate backup + exit-43
  protocol, session auth (lockout, rate limit, sliding expiry), RBAC + exhaustive matrix
  test, audit trail service + admin UI, user management with instant session revocation,
  daily/manual backups + download UI, seed script, login + app shell + admin pages,
  auth E2E incl. forced password change (110 unit/integration + 16 E2E tests).
- 2026-07-10 — Phase 1: self-update pipeline — release.yml builds win32 zips on green main
  → GitHub Releases; zero-dep supervisor.cjs applies staged updates (exit 42), health-gates
  new releases, auto-rolls-back on boot failure/crash-loop WITH database restore; WinSW
  service config + office installer script; in-app update banner + one-click Update Now
  (admin) + status polling through restart; private-repo PAT support; full local drill
  script proving update + rollback against a mock feed.
- 2026-07-10 — Phase 0: monorepo scaffold (Express 5 + React 19 + Tailwind 4 + better-sqlite3
  stack), shared unit/enum/version helpers with unit tests, health endpoint + integration test,
  Playwright smoke E2E, ESLint/Prettier/TS-strict, CI skeleton, living docs tree.
