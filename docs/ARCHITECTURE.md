# Architecture

## Stack

| Layer | Choice |
|---|---|
| Server | Node 24 LTS (pinned), Express 5, TypeScript strict (ESM), esbuild → `server/dist/index.js` |
| DB | better-sqlite3 (WAL, `synchronous=FULL`, `foreign_keys=ON`), single connection, raw SQL |
| Auth | Server-side sessions (httpOnly SameSite=Lax cookie, 12h sliding), bcryptjs, rate-limited login |
| Client | React 19 + Vite + Tailwind 4 + TanStack Query v5 + react-router + react-hook-form + zod 4 + Recharts |
| Shared | `shared/src` imported as `@shared` by server, client, and tests (tsconfig path alias) |
| Files | multer (memory) → sharp resize → `data/uploads/` |
| Excel | exceljs — generic `exportTable` util shares column defs with the on-screen DataTable |
| Ops | WinSW service → `supervisor/supervisor.cjs` → app from `releases\<v>\`; GitHub Release zips |
| Tests | Vitest (unit + supertest integration), Playwright E2E; CI on ubuntu + windows |

## Repo layout

```
shared/src/        enums, unit conversions, doc numbering, version compare, date rules
server/src/
  config.ts        env + version + paths (appRoot = repo root OR release-zip root)
  app.ts           express factory (used by tests)
  index.ts         entrypoint: listen + graceful shutdown
  db/              connection, migrations/NNN_*.sql, migration runner, seed
  routes/          one file per route group; RBAC declared per group
  services/        business logic; ALL ledger writes in sync db.transaction()
  middleware/      auth, rbac, audit, validation
  utils/           excel export, image pipeline
client/src/
  pages/           one folder per module
  components/      DataTable, FormModal, inputs (DzPc, Money, Date), StatusBadge…
  api/             fetch wrapper + TanStack Query hooks
supervisor/        zero-dep process manager (CJS, never auto-updated)
e2e/               Playwright specs
scripts/           setup / install-service / packaging helpers
.github/workflows/ ci.yml (every push), release.yml (main → GitHub Release)
data/              app.db, uploads/, backups/  ← gitignored, survives updates
```

## Core invariants

1. **Units are integers**: pieces (1dz=12), cm, paise. `shared/src/units.ts` is the only
   conversion path; floats never reach SQL.
2. **Single stock ledger** (`stock_ledger`): signed rows; balance = SUM. Seven stages:
   RAW/CUT/WIP/CHECKING/PACKING/FG/REJECTED. Inventory changes ONLY through
   `ledger.service` calls inside synchronous `db.transaction()` — no `await` inside.
3. **Genesis/terminal whitelist**: stock is created only by
   `opening|purchase|cutting_output|receipt_excess|adjustment_in` and destroyed only by
   `cutting_consume|check_missing|pack_short|reject_writeoff|dispatch|adjustment_out`;
   all other movements are balanced ± pairs. Enforced by tests.
4. **No hard deletes.** Masters: soft-delete/deactivate. Documents: admin-only void that
   writes reversal ledger rows; blocked if downstream consumption exists.
5. **Every mutation**: zod-validated, RBAC-checked, audit-logged (old/new JSON).
6. **Migrations additive-only** (CI lint rejects DROP/ALTER COLUMN); run at boot inside a
   transaction; DB backed up before each migration batch.

## Version & config resolution

`server/src/config.ts` resolves `appRoot` two levels above the entry file, which is the
repo root in dev AND the release root in production. `version.json` at that root (written
by CI) provides the running version; absent → `0.0.0-dev`. Client dist is looked up at
`client-dist/` (release layout) then `client/dist/` (repo layout).

## Concurrency model

One Node process, one better-sqlite3 connection. `db.transaction(fn)` executes
synchronously, so availability-check + write inside one service function is race-free.
Async work (image resize, network) must complete BEFORE entering a transaction.
Backups use `db.backup()` (online, WAL-consistent) — never file copies of a live DB.
