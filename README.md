# Bharti Enterprises — Production & Inventory Management System

A complete ERP for scrunchie manufacturing, replacing paper registers with full
traceability: **cloth purchase → cutting → contractor job-work → checking → packing →
finished goods → dispatch**, plus contractor payments, an owner dashboard, 15
Excel-exportable reports, batch traceability, audit trail and automatic backups.

**It ships as an Android app that runs the entire system on one device** — no server, no
network, works offline — and **updates itself with one tap**.

**📚 Start here:** [`docs/PROGRESS.md`](docs/PROGRESS.md) (build state) ·
[`docs/PROJECT_CONTEXT.md`](docs/PROJECT_CONTEXT.md) (the business) ·
[`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) (for staff) ·
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) (installing, releasing, signing, backups)

## Highlights

- **Trustworthy inventory**: a single append-only stock ledger with conservation rules
  enforced at write time (no manual edits, voids write reversals, FIFO lots with recorded
  allocations). Live self-checks on the admin System Health panel.
- **Contractor accountability**: partial receipts, shortages/excess with mandatory
  reasons, admin-only discrepancy closes, performance rankings, dues & payments.
- **Owner visibility**: dashboard KPIs + charts, alerts (delayed jobs, discrepancies,
  idle goods), every report downloadable as Excel, print views, full batch traceability
  back to the vendor.
- **Runs on one Android device**: the same route and service code that runs under
  Express is compiled into a Web Worker, with SQLite as WebAssembly on OPFS. No server,
  no network, no accounts to manage — and one implementation of the business rules, so
  one test suite covers both hosts.
- **Zero-drama updates**: push to `main` → CI (typecheck, lint, 330 unit/integration,
  58 E2E) → GitHub Release → in-app banner → Admin taps once → the app verifies the
  download's checksum, swaps its own bundle and restarts. **Business data is never part
  of an update**, and a bundle that fails to start twice is rolled back automatically.
- **Phone-friendly**: responsive UI throughout; also installable as a PWA when served
  from the optional PC deployment.

## Development

```bash
npm install
npm run dev          # Node host: server :8787 + client :5173
npm run dev:app      # the Android runtime, in a browser (in-app server, no backend)
npm test             # Vitest unit + integration
npm run build && npm run test:e2e   # Playwright: desktop + mobile + app projects
npx cap sync android && cd android && ./gradlew assembleDebug   # APK (needs JDK 21 + SDK)
node scripts/update-drill.mjs        # PC self-update + rollback drill (Windows)
```

Node 24 (`.nvmrc`). Dev sign-in after `npm run seed`: `admin / Admin@123`.
In the app build the first run generates the admin password and shows it once.

## Repository map

| Path | What |
|---|---|
| `shared/` | zod schemas, enums, integer-unit converters (pieces/cm/paise) — one source of truth |
| `server/` | Express 5 + better-sqlite3: routes → services → stock-ledger engine |
| `client/` | React 19 + Vite + Tailwind 4 SPA (TanStack Query, Recharts) |
| `supervisor/` | zero-dependency process manager the Windows service runs (never auto-updated) |
| `scripts/` | office installer, release packaging, update drill, E2E server |
| `e2e/` | Playwright suites |
| `docs/` | living documentation — updated with every change (see CLAUDE.md rule) |
