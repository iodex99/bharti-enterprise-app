# Changelog

Newest first. Every meaningful change gets a line. CI release notes are generated from
commit messages; this file is the human-curated history.

## Unreleased

- 2026-07-23 — **The system is now an Android app.** Everything runs on one device: the
  screens, the business rules and the database, with no server and no network (the
  internet is used only to look for updates). The server was not rewritten — the same
  route and service files are compiled into a Web Worker where `express` and the Node
  builtins resolve to small shims, so one implementation of the business rules stays
  covered by one test suite (ADR-021/023). Storage is **SQLite compiled to WebAssembly on
  OPFS** (ADR-022), and **photos moved into the database** (migration 003) so one file is
  the whole business — which is what backup, restore and moving to a new device depend on
  (ADR-024).

  **Updates are one tap.** A push to `main` publishes a release; the installed app checks
  every 30 minutes, and the Admin taps *Update now*: the new bundle is downloaded,
  checksum-verified, checked for completeness, swapped in, and the app restarts itself —
  Android installs nothing and the user confirms nothing. **Business data is never part of
  an update** (it lives in storage the swap cannot reach) and a safety copy is taken first
  anyway; a bundle that fails to start twice is rolled back automatically, with a notice
  that stays until someone acknowledges it (ADR-025/026). When the native shell itself
  changes, the app says the app file must be installed rather than pretending otherwise.

  Backups export the whole business to Android's share sheet (Google Drive in one tap),
  restore accepts it back on a new device, and demo mode still works as a second database.
  New: `android-release.yml` (gated on the full suite) publishing bundle + APK + manifest,
  the `app` E2E project running the real bundle in Chromium — including the update drill
  with damaged, incomplete and non-starting releases — and unit tests pinning the shims
  against the real Node modules.

- 2026-07-23 — Six workflow corrections from the owner's real process (migration 002):
  **(1)** the model is now decided at CUTTING — purchases are just vendor + color +
  meters (a hidden RAW-CLOTH bookkeeping model fills the old columns; RAW stock, reports
  and traceability show color/vendor); **(2)** cutting plans enter cloth per piece in
  INCHES plus how many pieces fit across the width — the app computes the cloth needed
  and shows what will be left, refusing over-consumption; **(3)** cutting plans can be
  EDITED and DELETED while still planned (cloth restored, doc number kept);
  **(4)** goods a contractor claims to return now sit in **Pending for checking** —
  checker allotment names the specific received batch, so the contractor ↔ checker
  mapping is explicit, jobs show an "Awaiting check" column, and missing/rejected pieces
  are attributed to the contractor's batch; **(5)** receipts can carry a **photo** of the
  returned goods, visible wherever the batch appears; **(6)** checkers & packers no
  longer have fixed roles — any staff member can do either job (role dropdown removed) —
  and quantities follow the registers' ink colors: **blue = issued out, red = received
  in**. (ADR-016…020.)

- 2026-07-22 — One-file migration to a new computer: a **complete backup** bundles the
  database AND every uploaded photo into one `.zip` (Backups → *Download complete backup*,
  or *Send to Google Drive*). A safe **in-app Restore** replaces all data atomically — it
  copies the current data aside, swaps in the backup, re-checks integrity and rolls back
  automatically on any failure, then signs everyone out to re-authenticate against the
  restored data. Restore refuses a backup from a newer app version, and is blocked in demo
  mode. A **first-run setup wizard** now greets a brand-new install: *start fresh* or
  *move from another computer*. (adm-zip added; ADR-014/015.)

- 2026-07-13 — Discrepancy review workflow: new Production → Discrepancies page listing
  every recorded difference (cutting variance, job excess/shortage, checking
  missing/rejected, packing short) with its source document, item and contractor/staff;
  admin-only Resolve with a mandatory note (acknowledgement only — never a stock
  movement, ADR-013); dashboard discrepancy alerts and the "Unresolved discrepancies"
  tile now open this page instead of Reports; demo data ships with resolved + unresolved
  examples. Dev-only fix: Vite proxy now preserves the Host header so sign-in works on
  the dev server (the CSRF origin guard was rejecting proxied logins).

- 2026-07-11 — Backup schedule moved to 1 PM IST with catch-up/retry: the last successful
  daily backup is tracked in settings and re-attempted hourly and at every start-up until
  the day's backup exists (PC off at 1 PM or a failed run no longer means a missed day);
  Backups page shows the last daily backup date; backup filenames now millisecond-unique.

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
