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
- **ADR-021** The product ships as an **Android app that runs the entire system on one
  device** — no server, no PC, no network. The server is not rewritten: `express` and the
  Node builtins resolve to small shims (`client/src/local/shims/`) and the real route and
  service files are compiled into a Web Worker (`vite build --mode app`). One
  implementation of the business rules therefore stays covered by one test suite, and the
  Node/Express host is kept for development, the automated suites and an optional PC
  deployment.
- **ADR-022** Storage is **SQLite compiled to WebAssembly on the OPFS "SAH pool" VFS**.
  It is the only browser store that is both synchronous and durably incremental, which is
  what the app's "no `await` inside a transaction" rule requires. The alternative OPFS VFS
  needs COOP/COEP headers; the SAH pool does not. Very old WebViews fall back to an
  in-memory database mirrored into IndexedDB, and the app says so.
- **ADR-023** The server runs in a **Web Worker**, not on the UI thread. The worker's
  single thread reproduces exactly the "one process, one connection" guarantee the ledger
  engine was written against, and long synchronous SQLite work cannot freeze the screen.
  The page reaches it by patching `fetch` for `/api` and `/uploads`, so every page, hook
  and query in the client is unchanged and cannot tell which host it is talking to.
- **ADR-024** **Photos live in the database** (migration 003, `upload_files`), not on a
  filesystem: there is no synchronous filesystem in the WebView, and it makes "the whole
  business is one file" literally true, which is what backup, restore and moving to a new
  device all depend on. Restore still imports the `uploads/` folder of a pre-003 backup.
- **ADR-025** Updates replace the **web bundle**, not the APK. Android cannot let an app
  install an APK over itself without a system prompt, so one-tap updating is delivered the
  way every app with live updates does it: download → verify sha256 → unpack → point the
  WebView at the new bundle → restart. Business data lives in the origin's private storage
  and is not part of a bundle, so an update cannot touch it. A release also publishes an
  APK plus `minNativeVersion`; when the native shell itself changed, the app says the app
  file must be installed instead of pretending it can do it silently.
- **ADR-026** A bundle is **verified before activation and rolled back after**: the
  checksum must match, `index.html` and every script it references must be present, and
  the declared version must agree with the release. If a bundle still fails to start
  twice, the previous one is put back automatically and the user is told — the notice
  persists until acknowledged, because whoever tapped Update is often not who opens the
  app next.
- **ADR-027** The product is a **PC web app again** (client decision, 2026-07-24): a
  central office computer runs the server, operators enter data from browsers/phones.
  `release.yml` builds PC zips on every push to main (1.0.x line, supervisor feed);
  `android-release.yml` is dormant (manual dispatch only). The Android/local runtime code
  stays in the tree but nothing ships it; the app-mode E2E project was deleted.
- **ADR-028** Multi-office is **one database with an `office_id` column**, not one file
  per office. Backup/restore/demo/reconciliation stay whole-business operations. Office 1
  ('HO') exists from the migration and keeps plain document numbers; later offices prefix
  theirs (`BR-RM-0001`) so numbers stay unique globally. Operators are pinned to exactly
  one office (users.office_id); admin/owner have no office and pick one per session via
  the `X-Office-Id` header (stored client-side; switching reloads the whole app). Masters,
  staff, contractors, vendors and users are shared; every document, ledger row and report
  is office-scoped. Conservation checks stay global — cloth is cloth wherever it is.
- **ADR-029** Cloth is measured in **yards and inches, stored as integer
  hundredths-of-an-inch** ("inch_c", 1 yd = 3600). Purchases record length AND width;
  cutting computes cloth as `ceil(pieces ÷ pieces-across-the-width) × inches-per-piece` —
  pure integer arithmetic, no floats in the database (the meters/cm columns are still
  written for compatibility but never read). Rates are per yard.
- **ADR-030** There is **no Models master**. The CODE NUMBER is typed on each cutting
  line (beside the size, with the product photo) and becomes the "size-code" —
  `315-XS` — shown everywhere downstream. Codes are find-or-created in the legacy models
  table so the ledger's dimension system, trace and reports are unchanged; a re-used code
  reactivates itself and the newest photo wins. Pickers read `GET /api/products`.
- **ADR-031** The cutting **plan IS the cutting**: recording it consumes the cloth and
  creates the cut pieces in one step — there is no "record actuals" and no cutting
  variance. Entries can be edited or deleted while none of their pieces have been issued
  onward; an edit reverses and re-applies inside one transaction and keeps the document
  number.
- **ADR-032** A job receipt **requires a photo** of the returned goods — every code's
  return is photographed, and the checker refers to it.
- **ADR-033** One job issue can cover several codes/colors, but the system creates **one
  job card per code + color** in a single transaction ("issued together, tracked
  separately"). Cards with no receipts yet can be edited or deleted. The per-dozen cost is
  set at issue on every line.
- **ADR-034** Checking has **one "rejected pieces" entry with a reason dropdown** —
  'missing' is one of the reasons. Internally missing pieces are a terminal write-off plus
  a discrepancy row (they do not physically exist, so they never sit in REJECTED stock);
  the other reasons move pieces to REJECTED.
- **ADR-035** There is **no packing module**. Packing is allotted from the checking row
  ("Pack" button on the passed pieces), the checker is the default packer, and "keep
  aside" is a **labeled bundle** (`pack_issues.kind = 'bundle'`) that can be packed later
  by anyone. Bundle stock carries its original allocations forward so trace still reaches
  the vendor.
- **ADR-036** **Pending dues** is a first-class view (`GET /api/contractors/dues`, the
  Dues page, and a report): job-work cost (received × rate set at issue) minus payments,
  per contractor.
- **ADR-037** Checkers/packers are **paid per dozen like contractors**: the usual rate
  lives on the staff master, is snapshotted onto every check/pack issue (editable per
  batch), and earnings accrue from RESULTS — every checked piece (passed, rejected or
  missing was all work done) and every packed piece. `staff_payments` mirrors
  contractor_payments (dated partial payments, SPAY numbers, admin void). The Pending
  Dues page settles BOTH contractors and staff, and both masters carry a payment-QR
  photo shown when recording a payment. The client's real sizes (HR, PIPE, JUMBO) are
  the seeded defaults.
- **ADR-038** **Phones get cards, not tables.** Operators work on phones, where a wide
  table pushes the quantity and the action button off-screen — an operator simply never
  finds them. Below the `sm` breakpoint every list (`DataTable` and the `MiniTable` used
  by Checking & Packing) renders one stacked label/value card per row with its buttons
  underneath; the table returns on tablets and laptops. Photo/QR links are never bare
  emoji: `ThumbLink` gives each a 36px hit area. Exactly ONE layout is in the DOM
  (`useIsCompact`, a `useSyncExternalStore` over matchMedia) — a CSS-hidden copy still
  doubles every text match for screen readers and tests. Cards carry `role=table/row/cell`
  so a card IS its table row to anything reading the page. Phones get a "Sort by" picker
  since there are no column headings to click.
- **ADR-039** **A payment may only be booked in an office where that person actually
  worked.** Earnings and payments are both office-scoped, so a payment recorded in the
  wrong office settles nothing: the money leaves and the dues stay on the other office's
  page forever. Both payment services now refuse it by name ("Meena has no job work in
  Branch Office"). Advances are still allowed where the work is.
- **ADR-040** **Checkers are paid for pieces they inspected — passed + rejected, never
  missing.** Missing pieces never reached the checker, and paying for them would reward
  declaring goods missing, which also writes stock off. Job-work cost and staff pay both
  round ONCE per line/issue over the total, so the job card, the dues page, the dashboard
  and the reports always show the same number.
- **ADR-041** **A settled job card takes nothing more.** The excess-receipt path exists
  for a contractor handing back more than *pending*, not for reopening a completed card;
  without the guard, choosing the wrong card conjured stock and billed the contractor for
  it. Further goods need a new job card.
- **ADR-042** **PC releases are published to the PUBLIC `bharti-releases` repo, not the
  private source repo.** The install token was the worst part of the deployment: a
  fine-grained PAT had to be created by hand, pasted into the installer, stored in
  `supervisor/config.json` — and when it expired the office simply stopped seeing updates,
  with nothing on screen to say so. A public feed removes the token from installation and
  from update polling entirely; there is now nothing to create and nothing to renew. The
  source stays private. The cost, accepted deliberately: the built app zip is
  world-downloadable. Business data never travels in a release, and the app still requires
  a sign-in, so what leaks is compiled code, not the business.
- **ADR-043** **The office PC installs updates itself, once nobody is working.** Waiting
  for an admin to notice a banner and press a button meant real installs sat versions
  behind. Applying one restarts the server, so it waits for a genuinely quiet moment —
  `auto_update_idle_minutes` (default 3) with no deliberate user request — rather than a
  clock, because offices keep their own hours. Crucially, screens that refresh on a timer
  (dashboard, stock, health, the update check itself) are excluded from "activity" server
  side: counting them would let one browser tab left open on a desk block every future
  update, and the exclusion lives on the server so a tab running the PREVIOUS version's
  code cannot veto the next one. Admin can turn it off (`auto_update`). Every existing
  safeguard still applies: DB backup first, health gate, automatic rollback.
- **ADR-044** **Every release ships the Node runtime it was built against.** The native
  modules (better-sqlite3, sharp) are compiled for one Node ABI, so "install Node 24 first,
  exactly 24" was both a prerequisite the office could get wrong and a whole class of
  confusing `NODE_MODULE_VERSION` boot failures. The release now carries `node/node.exe` —
  literally the interpreter CI built the modules with — the supervisor runs each release
  with its own, and the installer copies one to the root for the supervisor itself. The
  office PC needs nothing pre-installed. Cost: ~55 MB added to each release zip.
