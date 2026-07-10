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

## Coverage map (grows per phase)

- Phase 0: shared units/version/dates (unit), health endpoint (integration), app shell (e2e).
