# Changelog

Newest first. Every meaningful change gets a line. CI release notes are generated from
commit messages; this file is the human-curated history.

## Unreleased

- 2026-09-12 — **One-command install, and the office PC now updates itself**
  (ADR-042…044).

  **Install is one line.** No prerequisites at all: every release now ships the Node
  runtime its native modules were compiled against (`node/node.exe`), the supervisor runs
  each version with its own interpreter, and the installer copies one to the root for
  itself. That deletes the "install Node 24, exactly 24" step *and* the
  `NODE_MODULE_VERSION` boot failures that followed when someone installed 22 or 26.
  PC releases moved to the **public** `bharti-releases` feed, so there is no token to
  create at install and none to expire silently later. Offline installs are one command
  too (`-ZipPath`), replacing the twenty-line manual sequence. The installer now reads
  the version out of the release itself (so `releases\<v>` and `current.txt` cannot
  disagree — the classic manual-install failure), keeps existing config on re-run, and
  waits for `/api/system/health` before reporting success. Release zip: ~70 MB.

  **Updates apply themselves.** Polling went from every 15 minutes to every minute, and
  a new version is applied automatically once nobody has worked for a few minutes,
  instead of waiting for an admin to notice a banner and press a button — a push now
  reaches the office in 6–10 minutes, nearly all of it CI. Applying one restarts the
  server, so "quiet" is measured from real user requests. Screens that refresh on a timer
  (dashboard, stock, health, the update check) are excluded server-side, because
  otherwise one browser tab left open on a desk would block every future update — and
  server-side so that a tab running the *previous* version cannot veto the next one.
  Admin → System Health can turn it off or change the quiet period. All the existing
  safeguards still apply: DB backup first, health gate, automatic rollback.

  Also: the PC updater now selects the `bharti-app-*.zip` asset by name, since the PC and
  dormant Android lines share one releases repo and "first zip wins" would have had the
  office server download an Android web bundle.

  14 new tests (662 total), covering the asset-selection guard and — the one that keeps
  the feature honest — that background polls do not count as user activity.

- 2026-09-12 — **New `docs/INSTALL_CLIENT.md`: step-by-step client installation guide.**
  Written for whoever installs the system at the office (not for someone who knows this
  codebase): pre-visit checklist, two install paths — **A online** via `install-service.ps1`
  + GitHub Releases, **B offline** from a USB stick with the zip built by
  `package-release.mjs` — then first sign-in, Tailscale remote access, business setup
  (offices → users → masters → opening balances), backups, PC migration, a symptom-based
  troubleshooting table and a 19-point go-live checklist.

  Adds practical items the reference docs did not carry: disabling sleep/hibernate on the
  office PC (a sleeping server is the most likely "system is down" call), the native-module
  rule that the **build-time Node major must equal the office PC's** (or boot fails with
  `NODE_MODULE_VERSION`), the `current.txt`-must-match-`releases\<v>` trap in a manual
  install, and an optional LAN firewall rule for in-office desktops.

  Also corrects `DEPLOYMENT.md`, whose banner still announced the Android app as the
  shipped product — contradicting ADR-027 and `release.yml`. Part 1 is now labelled
  dormant and Part 2 is identified as the shipped deployment.

- 2026-07-27 — **Full-system audit: phone-first lists, and nine defects found and fixed**
  (ADR-038…041). The whole system was walked end to end — every login, every permission,
  every workflow — with two independent audits and ~250 new automated checks.

  **Made for phones** (ADR-038): every list becomes stacked cards below tablet width.
  This was not cosmetic — on a 360px screen the "Issue to checker" button and the
  waiting quantity were *off the right edge*, so an operator on a phone could not see
  the work waiting for them. Photo/QR links went from 19px to a 36px finger target, and
  the header no longer squashes the logo. Verified on 360/390/768px: no page scrolls
  sideways and every modal fits.

  **Cutting**: the cloth-batch dropdown no longer lists RM- batch numbers — a roll is
  chosen by *colour, yards left and width*, which is how the cutter recognises it.

  **Money and data-integrity fixes:**
  - A payment booked in the wrong office used to be accepted and then settle nothing —
    the money left and the dues stayed forever. Now refused by name (ADR-039).
  - Checkers were paid for pieces they reported *missing* — pieces that never reached
    them, which also rewarded writing stock off. Pay now follows what was inspected
    (ADR-040).
  - The job card, dues page, dashboard and reports could disagree by a paise or two on
    split deliveries; all four now round the same way (ADR-040).
  - A **fully settled job card** still accepted more goods, inflating the contractor's
    bill with stock from nowhere (ADR-041).
  - Rejections with two reasons wrote **one** discrepancy blaming the first reason for
    everything ("14 pcs damage" when 10 were colour defects). One row per reason now.
  - Traceability and discrepancy-resolve were **not office-scoped** — a branch operator
    could walk head office's finished goods back to the vendor, and an admin could
    resolve another office's discrepancy. Both fixed and covered by a new isolation
    suite.
  - Voiding anything the ledger refused reported *"Invalid request body"* instead of the
    real reason ("60 pcs have already moved on").
  - A voided job card left its FIFO allocations behind; SQLite recycles row ids, so a
    later cutting edit could silently inherit them.
  - A bundle emptied and then given pieces back (child void) was stuck "completed" and
    could never be packed again.
  - The purchase trace still printed cloth in **metres** from the retired column.

  **Test coverage**: RBAC matrix 92 → 376 assertions (it could not even express PUT or
  DELETE before, and covered 23 of ~126 routes); new `office-isolation` suite (16) that
  attacks every read and write across the office boundary; new `workflow-integrity`
  suite (10). 648 unit/integration + 51 E2E green.

- 2026-07-25 — **Checker/packer pay, payment QR codes, dues settled in place, and the
  client's real sizes** (ADR-037, migration 005):
  - Checkers & Packers carry a **rate per dozen** on their master; it fills in (editable)
    when a batch is allotted for checking or packing, and their pay accrues from the
    recorded results.
  - **Pending Dues now settles everyone**: contractors AND checkers/packers, each row
    with a **Record payment** button — part-payments with their date are the normal
    case; the balance stays pending. Payments can be voided by the admin.
  - Contractor and staff masters take a **payment QR code photo**, shown in the dues
    rows and inside the payment dialog.
  - New `staff-dues` report; `/api/staff` routes (dues/analytics/payments).
  - Seed + demo data rebuilt around the client's default sizes **HR, PIPE, JUMBO**,
    with staff rates, QR images and part-paid staff dues in the demo story.

- 2026-07-24 — **Fix: entering demo mode now migrates an existing demo database first.**
  A demo db built by an older app version is missing the newer tables; swapping onto it
  un-migrated made every request fail (found when the E2E server reused a pre-v2 demo db
  — the same thing would happen on a real install after any update). Regression test
  rolls a migration back and proves re-enter heals it. The E2E server also wipes the
  demo sibling directory now, so suite runs are hermetic.

- 2026-07-24 — **Back to the central-PC web app, now multi-office, and the workflow
  reworked end to end** (ADR-027…036). The client runs the system on one office computer
  again; operators enter data from browsers. What changed in the business flow:
  - **Offices**: the admin configures offices in the app; each office's documents, stock
    and numbering stay separate (`BR-RM-0001` style prefixes for offices after the
    first); operators are pinned to one office, admin/owner switch from the top bar and
    create logins per office.
  - **Yards + width**: cloth is bought in yards (1 yd = 36") with its width; cutting
    works out cloth as strips across the width (`ceil(pcs ÷ across) × inches/pc`).
  - **The code number is given at cutting**: no Models master — the code is typed beside
    each size (with the product photo) and that "size-code" (e.g. `315-XS`) follows the
    goods everywhere.
  - **Cutting is final**: the entry consumes cloth and creates pieces in one step (no
    "record actuals"); entries can be edited/deleted until pieces are issued onward.
  - **Job work**: per-dozen cost set at issue; multi-code issues split into one card per
    code + color; unstarted cards can be edited/deleted; receipts REQUIRE a photo of the
    returned goods.
  - **Checking**: one "rejected pieces" entry with a reason dropdown — 'missing' is a
    reason, not a separate box.
  - **Packing folded into checking**: a Pack button on the checked row; the checker packs
    their own goods by default; "keep aside" is a labeled bundle packed later.
  - **Pending dues**: a dedicated view + report of what each contractor is owed.
  Android/local runtime is dormant (ADR-027): PC releases build on every push again
  (1.0.x), the Android workflow is manual-only, and the app-mode E2E project was removed.

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

  Follow-ups from the first CI run: switching demo mode fired **two** navigations to
  /login (a router navigation *and* a full reload), which raced each other — now a single
  page load, which is what "everything cached belongs to the old database" actually calls
  for. Releases moved to the **1.1.x** line and the PC pipeline became manual-only:
  running both on every push raced for version tags and, worse, whichever finished last
  became `releases/latest` — the feed installed apps read — where a PC zip has no
  Android manifest and looks like a broken release to every device.

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
