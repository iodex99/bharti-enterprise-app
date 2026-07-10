# Bharti Enterprises — Production & Inventory Management System

Web-based manufacturing ERP for scrunchie production: raw cloth purchases → cutting →
contractor job-work → checking → packing → finished goods, with full batch traceability,
discrepancy tracking, contractor payments, owner dashboard, Excel exports, and a
one-click self-update mechanism for its office-PC deployment.

**📚 Start here: [`docs/PROGRESS.md`](docs/PROGRESS.md)** (current state) ·
[`docs/PROJECT_CONTEXT.md`](docs/PROJECT_CONTEXT.md) (the business) ·
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (how it's built)

## Quick start (development)

```bash
npm install
npm run dev        # server :8787 + client :5173 (proxied /api)
npm test           # unit + integration
npm run build && npm run test:e2e   # Playwright E2E
```

Requires Node 24 (see `.nvmrc`).

## Stack

Node 24 · Express 5 · better-sqlite3 · TypeScript strict · React 19 · Vite · Tailwind 4 ·
TanStack Query · Recharts · exceljs · Vitest · Playwright · GitHub Actions → self-updating
Windows deployment (WinSW + supervisor + GitHub Releases).

## Repository map

| Path | What |
|---|---|
| `shared/` | enums, unit conversions (pieces/cm/paise), doc numbering — one source of truth |
| `server/` | Express API + SQLite + business services (stock ledger engine) |
| `client/` | React SPA (mobile-first) |
| `supervisor/` | zero-dep process manager for the office machine |
| `e2e/` | Playwright suites |
| `docs/` | living documentation — updated with every change |
