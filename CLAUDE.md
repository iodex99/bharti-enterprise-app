# CLAUDE.md — Working Rules for This Repo

Bharti Enterprises Production & Inventory Management System — a web ERP for a scrunchie
manufacturer. Full context lives in `docs/`; **read `docs/PROGRESS.md` first** in any new
session to learn current state and next steps.

## Living documentation rule (non-negotiable)

After EVERY meaningful change:

1. Update the affected doc(s) in `docs/` — `ARCHITECTURE.md`, `DATA_MODEL.md`, `API.md`,
   `FEATURES.md`, `USER_GUIDE.md`, `DEPLOYMENT.md`, `TESTING.md` — whichever the change touches.
2. Add a line to `docs/CHANGELOG.md` (newest first).
3. Keep `docs/PROGRESS.md` current: phase checklist, "current state", "next steps".
4. Record any locked design decision as an ADR line in `docs/DECISIONS.md`.

A phase is NOT done until: tests green + docs updated + committed & pushed.

## Commands

- `npm run dev` — server (tsx, :8787) + client (vite, :5173) together
- `npm run build` — server (esbuild → server/dist) then client (vite → client/dist)
- `npm test` — Vitest unit + integration (server workspace)
- `npm run test:e2e` — Playwright (requires `npm run build` first; serves on :8788)
- `npm run typecheck` / `npm run lint` / `npm run format`
- `npm run seed` — demo/dev data

## Hard rules

- **Units:** integer pieces (1dz = 12), integer cm, integer paise. Never floats in the DB.
  Conversions ONLY via `shared/src/units.ts`.
- **Inventory:** moves ONLY through the ledger service inside synchronous
  `db.transaction()` blocks — no `await` inside a transaction, no manual stock edits,
  no hard deletes (soft delete / void with reversal rows).
- **Migrations:** additive only (no DROP/ALTER COLUMN). Numbered `server/src/db/migrations/NNN_*.sql`.
- **Every mutating endpoint:** zod-validated body, RBAC-checked, audit-logged.
- **Business dates** are `YYYY-MM-DD` strings; timestamps are UTC ISO. Display DD/MM/YYYY (IST).
- Versions ship as `v1.0.<run_number>` GitHub Releases built by CI; the office server
  self-updates via the supervisor (see `docs/DEPLOYMENT.md`). `data/` is sacred — never in git.

## Layout

- `shared/src/` — enums, unit conversions, doc numbering, version compare (imported as `@shared`)
- `server/src/` — Express 5 + better-sqlite3 (TypeScript, ESM, esbuild-bundled)
- `client/src/` — React 19 + Vite + Tailwind 4 + TanStack Query
- `supervisor/` — zero-dependency process manager for the office machine (never auto-updated)
- `e2e/` — Playwright specs (root `playwright.config.ts`)
