# Testing

## How to run

```bash
npm test              # Vitest: unit + integration (server workspace)
npm run build         # required before e2e (playwright serves server/dist)
npm run build:app     # the Android bundle (also rebuilt by the e2e webServer)
npm run test:e2e      # Playwright: desktop + mobile (:8788) AND app (:8789)
npm run typecheck     # tsc strict across workspaces
npm run lint          # eslint flat config
```

Playwright browsers: `npx playwright install chromium` once per machine.

## Layers

1. **Unit (server/tests/unit)** — pure logic: unit conversions, doc numbering, version
   compare, variance math, FIFO splitter, status machines, conservation whitelists.
2. **Integration (server/tests/integration)** — supertest against `createApp()` with a
   temp SQLite file per suite; asserts BOTH api responses AND ledger/audit rows.
3. **E2E (e2e/)** — Playwright against the production build (Express serving client/dist),
   desktop + mobile viewports.
4. **App E2E (e2e/app-mode.spec.ts, project `app`)** — the real Android bundle served as
   static files by `scripts/app-server.mjs`, running its own in-app server. Chromium is
   the same engine as the Android System WebView, so this covers SQLite-WASM on OPFS, the
   Express routes running in a worker, photo encoding via OffscreenCanvas, and the whole
   update flow against a mock release feed the script generates (including deliberately
   broken releases). Each test gets a fresh context — i.e. a brand-new device.

## Conventions

- Integration suites must never share a DB file; each creates its own temp dir.
- Every module phase adds: happy path, RBAC denials, validation rejections, and its
  domain edge cases (see plan §Test matrix) BEFORE the phase is called done.
- CI (`ci.yml`) runs typecheck + lint + unit/integration on ubuntu AND windows, then
  builds and runs E2E on ubuntu. Release only publishes from green main.

## Coverage map (v2 — multi-office, yards, codes-at-cutting)

**Browser-runtime unit tests:** the hand-written shims are checked against the real Node
modules — SHA-256 for every input shape and chunking pattern (a padding bug at 55-byte
inputs was caught this way), `node:path` against `node:path/posix`, and the Express shim's
routing semantics: params never crossing `/`, `router.param` guards running before
handlers, middleware that responds stopping the chain, mounted-router path remainders,
sync throws and rejected promises reaching the error handler, cookies round-tripping, and
unknown paths answering 404 rather than hanging. Plus the Android release manifest:
malformed/unverifiable manifests refused, and bundle-vs-APK selection either side of
`minNativeVersion`.

**Unit (60+):** integer unit converters incl. float-imprecision cases · inch converters +
cloth-consumption geometry (strip round-up, width-count, cm ceil) · doc numbering ·
version compare · business-date validation · FIFO splitter (exact/spanning/insufficient/
fractional-rejection) · variance math · update-feed parsing + checksum matching.

**Integration (150+, temp SQLite per suite):**
- auth: generic failures (no username probing), lockout, logout revocation, forced
  password change, session revocation on deactivate/reset/role-change, CSRF origin guard,
  login rate limit (dedicated suite)
- RBAC: exhaustive matrix — every route group × {admin, operator, owner, anon}
- masters ×6 lifecycle: dupes (case-insensitive), search, deactivate-vs-delete, delete
  blocked while referenced, uploads (webp conversion, auth-gated serving, traversal block)
- ledger conservation: genesis/terminal direction rules, unbalanced-transfer rejection,
  per-lot overdraw (single + grouped), atomic rollback of failed batches
- purchases: server-side totals, date rules, inactive-master rejection, idempotency
  replay, financial-only edits, void + downstream block
- opening balances: per-stage validation, WIP-with-contractor, voids
- cutting: geometry-computed consumption (inches × width, exact + round-up cases),
  over-consumption, duplicate sizes, missing geometry, variance-reason enforcement,
  unplanned sizes, opening-lot cutting (no model on RAW), edit re-plan (restore →
  recompute → same doc no; overdraw refused atomically; frozen after actuals),
  delete-planned (soft void, cloth restored), void restore + consumption block
- jobs: FIFO across batches with allocations, partial receipts 10dz=2+3+5 with
  auto-complete, excess (reason + genesis + discrepancy), unstitched returns to allocated
  lots, admin-only close with shortage writeoff, void rules, payments + dues math
- checking/packing: pending-pool listing (contractor + receipt + photo), DIRECTED issue
  against a named batch (single allocation; over-issue/unknown-batch rejected), any-staff
  gates (deactivated still refused), incremental sessions, breakdown-sum rule,
  over-session rejection, REJECTED stage, discrepancy attribution to checker AND source
  contractor, FG output, dispatch + ledger-replay void
- discrepancies: list joins source docs (unresolved first), admin-only resolve
  (acknowledgement — ledger row count proven unchanged), audit row, 409 double-resolve,
  alert links point at /discrepancies
- FULL-CHAIN CONSERVATION: genesis − terminal = on-hand, drift 0 (pieces) + RAW (inch_c)
- dashboard numbers vs fixture ledger; alerts feed
- offices: office 1 from migration, per-office doc numbers + stock split, operator
  pinning (403 without an office), header selection for admin/owner, session revocation
  on office change
- reports: all 16 run + column shape (office-scoped), filters narrow, losses
  completeness, xlsx
  round-trip parse (title/headers/values); trace to-vendor + forward; 404s
- system: reconciliation green + corrupted-row detection, settings whitelist + audit,
  daily-backup catch-up state machine (too-early/ran/idempotent/failure-retry/boot),
  cloud mirror lifecycle, full-report HTML+XLSX round-trips, demo-mode lifecycle
- complete backup + restore: snapshot zip carries DB+photos+manifest; restore rewinds all
  data AND photos atomically (later purchase + photo vanish), pre-restore safety copy kept,
  data_restore audited, reconciliation green after; rejects non-backup zip and a
  newer-version backup (forged future migration); refused in demo mode; first-run
  setup-state flips false once dismissed (admin-only)
- migrations idempotent; full schema presence

**E2E (21 scenarios × desktop + mobile viewports):** login/logout/forced-change,
RBAC walls, masters CRUD, purchase → raw stock, cutting with live variance + reason
enforcement, job partial receipts → auto-complete → contractor analytics, the whole
purchase→cutting→job→checking→packing→FG chain (ends with the missing-pieces
discrepancy reviewed and resolved by the admin), reports Excel download, traceability
tree, PWA (SW active + /api freshness through it), System Health + settings, complete
backup download → Restore preview/confirm-gate UI (desktop only; the atomic swap +
rollback itself is integration-tested).

**App E2E (9 scenarios, project `app`):** first run generates the admin, applies the
migrations and records real work through to the ledger; the demo business is built through
every service against SQLite-WASM and passes its own conservation checks; a photo is
resized, stored and served back as webp; a complete backup is taken, work continues past
it, and restoring rewinds exactly to it; a file that is not a backup is refused. Update
drill: a release is checked, downloaded, checksum-verified, unpacked, activated and
restarted into — **with the business data asserted unchanged afterwards** — while a
damaged download and an incomplete bundle are both refused without activating anything,
and a bundle that fails to start twice is rolled back to its predecessor with a notice
that survives until it is dismissed.

**Ops drills (scripts/update-drill.mjs, 13 steps):** seeded install boots under the
supervisor → admin one-click update → session + data survive → poisoned release
auto-rolls-back with DB restore → pointer correct.
