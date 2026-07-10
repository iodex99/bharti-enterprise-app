# Bharti Enterprises — Production & Inventory Management System

A complete web ERP for scrunchie manufacturing, replacing paper registers with full
traceability: **cloth purchase → cutting → contractor job-work → checking → packing →
finished goods → dispatch**, plus contractor payments, an owner dashboard, 15
Excel-exportable reports, batch traceability, audit trail, automatic backups — and a
**one-click self-update** system for its office-PC deployment.

**📚 Start here:** [`docs/PROGRESS.md`](docs/PROGRESS.md) (build state) ·
[`docs/PROJECT_CONTEXT.md`](docs/PROJECT_CONTEXT.md) (the business) ·
[`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) (for staff) ·
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) (office install + Cloudflare Tunnel)

## Highlights

- **Trustworthy inventory**: a single append-only stock ledger with conservation rules
  enforced at write time (no manual edits, voids write reversals, FIFO lots with recorded
  allocations). Live self-checks on the admin System Health panel.
- **Contractor accountability**: partial receipts, shortages/excess with mandatory
  reasons, admin-only discrepancy closes, performance rankings, dues & payments.
- **Owner visibility**: dashboard KPIs + charts, alerts (delayed jobs, discrepancies,
  idle goods), every report downloadable as Excel, print views, full batch traceability
  back to the vendor.
- **Zero-drama updates**: push to `main` → CI (ubuntu+windows, 211 unit/integration +
  42 E2E tests) → GitHub Release zip → in-app banner → Admin clicks once → supervisor
  swaps releases with automatic health-gated **rollback incl. database restore**.
  `data/` is never touched.
- **Phone-friendly**: responsive UI, installable PWA (update-safe service worker).

## Development

```bash
npm install
npm run dev          # server :8787 + client :5173
npm test             # Vitest unit + integration
npm run build && npm run test:e2e   # Playwright E2E (desktop + mobile)
node scripts/update-drill.mjs        # full self-update + rollback drill (Windows)
```

Node 24 (`.nvmrc`). Dev sign-in after `npm run seed`: `admin / Admin@123`.

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
