# Testing

## How to run

```bash
npm test              # Vitest: unit + integration (server workspace)
npm run build         # required before e2e (playwright serves server/dist)
npm run test:e2e      # Playwright, desktop + mobile projects, :8788
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

## Conventions

- Integration suites must never share a DB file; each creates its own temp dir.
- Every module phase adds: happy path, RBAC denials, validation rejections, and its
  domain edge cases (see plan §Test matrix) BEFORE the phase is called done.
- CI (`ci.yml`) runs typecheck + lint + unit/integration on ubuntu AND windows, then
  builds and runs E2E on ubuntu. Release only publishes from green main.

## Coverage map (final)

**Unit (60+):** integer unit converters incl. float-imprecision cases · doc numbering ·
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
- cutting: over-consumption, duplicate sizes, variance-reason enforcement, unplanned
  sizes, opening-lot cutting, void restore + consumption block
- jobs: FIFO across batches with allocations, partial receipts 10dz=2+3+5 with
  auto-complete, excess (reason + genesis + discrepancy), unstitched returns to allocated
  lots, admin-only close with shortage writeoff, void rules, payments + dues math
- checking/packing: staff-role gates, incremental sessions, breakdown-sum rule,
  over-session rejection, REJECTED stage, FG output, dispatch + ledger-replay void
- FULL-CHAIN CONSERVATION: genesis − terminal = on-hand, drift 0 (pieces) + RAW (cm)
- dashboard numbers vs fixture ledger; alerts feed
- reports: all 15 run + column shape, filters narrow, losses completeness, xlsx
  round-trip parse (title/headers/values); trace to-vendor + forward; 404s
- system: reconciliation green + corrupted-row detection, settings whitelist + audit
- migrations idempotent; full schema presence

**E2E (21 scenarios × desktop + mobile viewports):** login/logout/forced-change,
RBAC walls, masters CRUD, purchase → raw stock, cutting with live variance + reason
enforcement, job partial receipts → auto-complete → contractor analytics, the whole
purchase→cutting→job→checking→packing→FG chain, reports Excel download, traceability
tree, PWA (SW active + /api freshness through it), System Health + settings.

**Ops drills (scripts/update-drill.mjs, 13 steps):** seeded install boots under the
supervisor → admin one-click update → session + data survive → poisoned release
auto-rolls-back with DB restore → pointer correct.
