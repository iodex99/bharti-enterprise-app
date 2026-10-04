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

**THE PRODUCT IS THE CENTRAL-PC WEB APP AGAIN, NOW MULTI-OFFICE** (ADR-027…036,
2026-07-24). A central office computer runs the server; operators enter from browsers.
`release.yml` publishes PC zips (1.0.x) on every push; `android-release.yml` is dormant
(manual dispatch only) and the Android/local runtime stays in the tree unused.

**v2 workflow (what the app does now):**
- **Multi-office (ADR-028)**: one database, `office_id` on every document/ledger row.
  Office 1 'HO' from the migration keeps plain doc numbers; later offices prefix
  (`BR-RM-0001`; counters keyed `family@officeId`). Operators pinned to one office
  (users.office_id, sessions revoked on change); admin/owner pick per session via
  X-Office-Id header (client localStorage 'bharti.office'; switching reloads). Masters/
  staff/contractors/vendors/users shared. Admin configures offices at /admin/offices.
- **Yards + width (ADR-029)**: integer hundredths-of-an-inch ("inch_c", 1 yd = 3600).
  Purchases take length AND width, rate per yard; cutting consumption =
  `ceil(pcs ÷ widthCount) × clothPerPcInchC` (shared clothRequiredInchC). Legacy cm
  columns still written, never read.
- **Codes at cutting (ADR-030)**: no Models master. Code typed per cutting line + photo →
  find-or-create in the hidden models table (ids > 1000000, after the RAW-CLOTH
  sentinel); "size-code" label `CODE-SIZE` everywhere; pickers use GET /api/products.
- **Cutting is final (ADR-031)**: creation consumes RAW and creates CUT in one tx (no
  actuals, no variance); edit/delete while nothing is issued downstream (reverse +
  re-apply, doc number kept; delete = void with standard reason).
- **Jobs (ADR-032/033)**: receipts REQUIRE a photo; one issue → one card per code+color
  (`{cards:[…]}` response); per-dozen cost set at issue; receipt-less cards editable/
  deletable.
- **Checking (ADR-034)**: single "rejected pieces" + reason dropdown; 'missing' reason →
  terminal write-off + discrepancy (never REJECTED stock); others → REJECTED.
- **Packing from checking (ADR-035)**: no packing page. Pack button on the checked row
  (POST /api/checking/:id/pack), checker = default packer; bundles = pack_issues
  kind='bundle' with a label, packed later by anyone; allocations carried forward so
  trace reaches the vendor.
- **Pending dues (ADR-036)**: /dues page + GET /api/contractors/dues + report.
- **Staff pay (ADR-037, migration 005)**: checkers/packers carry a per-dozen rate
  (staff master) snapshotted onto check/pack issues; earnings accrue from results;
  staff_payments (SPAY-, office-scoped, voidable) settle them; Pending Dues settles
  contractors AND staff with dated partial payments; contractor/staff masters carry a
  payment-QR photo shown when paying. Client's default sizes: HR / PIPE / JUMBO.

Tests: 30 files / 648 unit+integration green; E2E rewritten for v2 (incl. offices.spec,
photo-required receipts, pack-from-checking + bundle flow). Demo data (populateDemo) is
v2: HO + BR offices, branch operator `branch-op`/Branch@123, codes 315/410/…, combined
job issue → 2 cards, a bundle, missing-as-reason.

Still live from earlier phases: in-app demo mode, complete backup/restore + setup wizard,
discrepancies review, reconciliation self-checks, PWA, dashboard.

**Deployment reworked 2026-09-12 → 2026-10-04 (ADR-042…045).** The office PC installs
with ONE line and no prerequisites:
`irm https://github.com/iodex99/bharti-releases/releases/latest/download/install.ps1 | iex`
(offline: double-click `install.cmd` beside `install.ps1` + the zip). Each release zip is
self-sufficient — app, its own `node/node.exe`, supervisor, WinSW (pinned + hashed) and
service config — and releases go to the PUBLIC `bharti-releases` feed, so there is no
Node to install and no PAT to create or renew. Re-running the installer is the safe
repair/upgrade path (stages while serving, DB safety copy, old release moved aside, full
rollback on failure — rehearsed incl. a deliberately broken upgrade). Updates apply
themselves: polled every minute, applied once nobody has worked for
`auto_update_idle_minutes` (default 3), timer-driven screens excluded from "activity".
Push → office running it: 6–10 min, nearly all CI. Guide: `docs/INSTALL_CLIENT.md`.

**BLOCKER for the one-line install: `RELEASES_REPO_TOKEN` is NOT set** (verified
2026-10-04: `bharti-releases` has zero releases; v1.0.21/v1.0.22 fell back to this private
repo). Until it is, the one-liner answers "no release has been published yet" and
installed PCs never see updates. Setup steps: INSTALL_CLIENT.md §1.1.

Next steps: set `RELEASES_REPO_TOKEN`, re-run the Release workflow, confirm the four
assets appear on the feed, then do one real install and watch one real push land
(go-live checklist items 3 and 14).

**Installer quirks discovered (don't relearn these):**
- `irm | iex` delivers the script as a string: it must be pure ASCII (5.1 mangles the
  rest), must never `exit` (closes the user's window), and `$PSScriptRoot` is empty.
- WinSW 2.x finds its config by its OWN file name in its own folder
  (`bharti-service.exe` ↔ `bharti-service.xml`); it takes no config-path argument.
- PowerShell 5.1 reads BOM-less files as ANSI — read the app's UTF-8 files with
  `-Encoding UTF8`, and write JSON the supervisor parses without a BOM.
- `Remove-Item -Recurse` gives up past 260 chars; `rd /s /q "\\?\path"` does not.
- When writing test .ps1 files through the Bash tool's heredocs, `\\` collapses to `\`
  — use the file-writing tool for anything with Windows paths.

**v2 quirks discovered (don't relearn these):**
- Code-created models get ids > 1000000 (the RAW-CLOTH sentinel holds 1000000) — tests
  must look model ids up by code, never hardcode.
- SQLite has no CEILING(): integer ceil is `((a + b - 1) / b)` (reports SQL).
- SQLite can't ADD COLUMN with REFERENCES + non-NULL default — office_id columns are
  plain INTEGER validated by the office middleware.
- check_result_rejections has an immutable CHECK that does NOT allow 'missing' — the
  service splits missing into qty_missing before writing rejections rows.
- pack_allocations' CHECK disallows lot_type 'pack_issue' — bundle sources carry the
  bundle's ORIGINAL allocations forward instead.

**Android quirks discovered (don't relearn these):**
- Capacitor finds plugins in the package.json NEXT TO capacitor.config.ts — the
  `@capacitor/*` deps must live in the ROOT package, not in `client/`. Installed in the
  workspace they silently register ZERO native plugins (`capacitor.plugins.json` = `[]`)
  and every plugin call fails only on a real device. Verify with `npx cap sync android`.
- The OPFS **SAH pool** VFS is the one to use: it needs no COOP/COEP headers, unlike the
  other OPFS VFS. `exportFile()` is async even though everything else is synchronous.
- The worker must NOT do its imports at module scope: a module that fails while
  evaluating cannot report anything, and the page just hangs. Load on first message.
- Android cannot silently install an APK over itself — hence bundle updates, with
  `android/native-version.txt` recording the run number at which the shell last changed.
- ONE workflow may publish to `releases/latest`: it is the update feed. android-release.yml
  owns it (1.1.x); release.yml (PC, 1.0.x) is workflow_dispatch only. `github.run_number`
  is per-workflow and restarts at 1, which is why the app line starts at a new minor.
- `page.evaluate` races the app's self-restart during the update drill ("execution
  context destroyed") — probe helpers must tolerate navigation.

**Environment quirks discovered (don't relearn these):**
- Repo is **private** — GitHub API needs auth; office installs need a fine-grained PAT
  (Contents: read) in supervisor config.json.
- Windows: use `C:\Windows\System32\tar.exe` (bsdtar) explicitly for zips — PATH tar may be GNU tar.
- Playwright starts webServer CONCURRENTLY with globalSetup → seed inside scripts/e2e-server.mjs.
- Playwright desktop+mobile share one server/DB → per-project usernames, raised login rate limit.
- react-hooks v7 lint: no setState-in-effect-body, no refs during render — inputs use
  initialize-once + remount-per-record (key=) pattern.

## Next steps

1. Office go-live on the central PC (docs/DEPLOYMENT.md): install service + tunnel, run
   the first-run wizard, create the second office + operator logins, enter opening
   balances per office.
2. Roadmap candidates when the owner asks: docs/ROADMAP.md (sales module, QR labels,
   WhatsApp alerts, low-stock thresholds, rework flow…).
3. If the client ever wants the Android app back: android-release.yml still works via
   manual dispatch (signing secrets already configured; keystore at the developer's
   `bharti-signing` folder).

**Audit findings baked into tests (2026-07-27).** Two independent audits (permissions,
workflow) walked the whole system; nine real defects were fixed and pinned by tests.
Things to remember:
- Office scoping must be checked on the ROOT document of any walk — trace/discrepancy
  resolve were missed because they take an id and never touched office_id. The new
  `office-isolation.test.ts` attacks every read and write across the boundary by
  guessing the other office's ids; run it after touching any service.
- `LedgerError` carries `status = 400`, which the body-parser branch of the error
  handler used to swallow ("Invalid request body"). The handler now answers LedgerError
  explicitly BEFORE that branch — keep that ordering.
- SQLite recycles row ids: any hard delete (cutting lines on edit) plus a surviving
  allocation row equals a silently mis-pointed allocation. Delete allocations with their
  document.
- Money rounds ONCE per line/issue over the total, in every query that reports it
  (jobs, contractors, dashboard, staffpay). Rounding per receipt makes screens disagree.
- The RBAC matrix now covers every route group and PUT/DELETE — add a row when adding a
  route; it is the cheapest guard in the repo (376 assertions).

## Session notes

- 2026-07-24 (PC + multi-office pivot, workflow v2): the client reverted to the central-PC
  setup and asked for 14 workflow changes — all shipped (ADR-027…036, see CHANGELOG).
  Implementation notes for the future: editCuttingPlan re-checks raw availability INSIDE
  the tx after reversing (same-lot edits get their own cloth back first); createJobIssue
  groups lines by (modelId,colorId) and returns `{cards:[…]}` — client shows one
  confirmation listing all cards; packHereSchema = packIssueSchema minus lot fields (the
  checking row IS the lot); recordCheckResult splits 'missing' rejections into qty_missing
  BEFORE writing rejections rows (DB CHECK forbids 'missing' there); listPendingDues joins
  last payment date; offices>1 doc numbers embed the office code so the global UNIQUE on
  doc_no holds; resolveOffice must run AFTER attachUser (it reads req.user).

- 2026-07-23 (Android pivot): see ADR-021…026. Implementation notes for the future: the
  express shim implements exactly the surface the routes use (verified by
  tests/unit/express-shim.test.ts) — extend it there, with a test, rather than reaching
  for real Express; the SQLite-WASM driver exposes only the better-sqlite3 subset the
  services call (prepare/run/get/all, exec, transaction with SAVEPOINT nesting, pragma,
  inTransaction) and prepares a fresh statement per call because the services re-enter the
  same SQL from nested transactions; `dataDirs.setDemoMode()` is what keeps `isDemoMode()`
  (and the DEMO banner) true in the app, and the demo choice is persisted by the bridge
  because the worker has no storage; hand-rolled SHA-256 needs MINIMAL padding (a 55-byte
  input exposed the bug — the unit test compares against node:crypto).

- 2026-07-23 (post-ship): six workflow corrections from the owner (see CHANGELOG). Key
  implementation notes for the future: the RAW-CLOTH sentinel model is pinned at id
  1000000 so test fixtures inserting masters with ids 1..N never collide; RAW ledger rows
  ALWAYS use the lot's stored model (rawLotModelId) — using the batch's model would split
  lot balances across dimensions; plan edit = adjustment_in restore → availability check
  INSIDE the tx → delete+reinsert lines → cutting_consume (doc no kept); "delete plan" is
  a void with a standard reason (no hard deletes); directed checking still writes
  check_allocations (single row) so traceability is untouched; demo model ids are captured
  from inserts, never hardcoded.

- 2026-07-22 (post-ship): Complete backup + one-file migration. New snapshot.service.ts
  (build/inspect/restore/cloud) reuses the demo runtime connection-swap but SYNCHRONOUSLY
  so the file swap is atomic vs other requests; pre-restore copy + auto-rollback; clears
  sessions; audits as system (userId null — restoring admin's id is a FK to the OLD db).
  First-run setup wizard gates a fresh install. adm-zip (0.6.0, patched DoS advisory).
  Watch-outs for future: restore/complete-backup MUST refuse demo mode (getDb() would hit
  the demo dir); snapshot is DB+uploads only (never the whole data dir).

- 2026-07-13 (post-ship): Discrepancies review page + admin resolve (user found alert
  links dumping into Reports; root cause was bigger — resolved_at columns existed but NO
  code ever set them, so warnings could only accumulate forever). Also fixed dev-only
  login 403: Vite proxy must keep the browser's Host header (changeOrigin:false) or the
  CSRF origin guard rejects proxied POSTs — production unaffected (same-origin serving).

- 2026-07-11 (post-ship): demo-data system added (separate data-demo DB, seed-demo.ts via
  service layer + reconciliation gate, dev:demo script); edge-case hardening (id param
  guards on all routers, SQLITE_CONSTRAINT→400 + body-parser 4xx passthrough in the
  central error handler, active-master checks at opening-balance/job-card entry points);
  234 unit/integration tests.

- 2026-07-10: project started; plan approved; Phases 0–2 built and verified. First push done
  (CI green on GitHub). Release pipeline live: every push to main publishes v1.0.<run_number>.
