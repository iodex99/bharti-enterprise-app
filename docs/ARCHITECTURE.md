# Architecture

## Two hosts, one system

The product ships as an **Android app that runs the whole system on a single device** —
no server, no office PC, no network needed. The business code is not duplicated to do
this: the very same route and service files run in both places.

```
                    shared/src            server/src (routes + services + ledger)
                        |                              |
        +---------------+------------------------------+---------------+
        |                                                              |
  NODE HOST (development, tests, optional PC)          ANDROID APP (what the client uses)
  express + better-sqlite3 + sharp                     Web Worker + SQLite-WASM/OPFS
  HTTP on :8787                                        postMessage, no network
```

On Android, `express`, `multer`, `cookie-parser`, `better-sqlite3` and the Node builtins
resolve to small shims in `client/src/local/shims/` (wired up by `vite build --mode app`),
and the server is compiled into a Web Worker. The page reaches it by patching `fetch` for
`/api` and `/uploads`, so every page, hook and query in the client is untouched.

| | Node host | Android app |
|---|---|---|
| Transport | HTTP (Express) | `postMessage` to a worker (`local/bridge.ts`) |
| Database | better-sqlite3, WAL | SQLite-WASM on OPFS (`local/db/sqlite-wasm.ts`) |
| Photos | `upload_files` table | same table (ADR-024) |
| Images | sharp | OffscreenCanvas (`local/image-processor.ts`) |
| Updates | supervisor + release zip | web-bundle swap (`local/updater.ts`) |
| Backups | files in `data/backups` | export the database + Android share sheet |
| Demo mode | second data directory | second database in the same store |

Operations that are about the *device* rather than the data — updates, backups, restore,
demo mode — are served on the UI thread by `local/native-ops.ts` under the same URLs the
Express host uses (`routes/system.node.routes.ts`), so the screens are identical.

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
client/src/local/   THE ANDROID RUNTIME
  boot.ts          start-up order: rollback gate → in-app server → mark healthy
  bridge.ts        patches fetch; page ↔ worker request/response + session cookie
  server.worker.ts the in-app server: opens SQLite, migrates, serves the real routes
  db/sqlite-wasm.ts better-sqlite3-compatible driver over SQLite-WASM (OPFS)
  shims/           express, multer, cookie-parser, node:fs/path/crypto/url
  updater.ts       check → download → verify → swap → health gate → auto-rollback
  native-ops.ts    /api/system endpoints that need the device (updates, backups…)
  shell.ts         device operations (Capacitor on Android, equivalent in a browser)
android/           Capacitor native shell (thin WebView host; native-version.txt)
supervisor/        zero-dep process manager (CJS, never auto-updated)
e2e/               Playwright specs (desktop + mobile against Node; app against the bundle)
scripts/           setup / install-service / packaging helpers / app-server + mock feed
.github/workflows/ ci.yml, release.yml (PC zip), android-release.yml (bundle + APK)
data/              app.db, backups/  ← gitignored, survives updates (Node host)
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
