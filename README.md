# Bharti Enterprises — Production & Inventory Management System

A complete ERP for scrunchie manufacturing, replacing paper registers with full
traceability: **cloth purchase → cutting (where the code number is given) → contractor
job-work → checking & packing → finished goods → dispatch**, plus contractor payments and
pending dues, an owner dashboard, 16 Excel-exportable reports, batch traceability, audit
trail and automatic backups.

**It runs on the central office computer** — operators enter the day's work from
browsers, the owner watches from anywhere, and **multiple offices share one system while
their data stays separate**. Updates are one click. (An Android on-device build also
exists, dormant — see docs/DEPLOYMENT.md.)

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
- **Multi-office**: the admin configures offices in the app; every document, stock
  figure and report belongs to one office (prefixed document numbers like `BR-RM-0001`),
  operators are pinned to theirs, and the admin/owner switch offices from the top bar.
- **Made for the shop floor**: cloth in yards + width with the piece math done for you,
  the product photo following its code everywhere, required photos of returned goods,
  and packing folded into checking (the checker packs their own goods, or keeps a
  labeled bundle aside).
- **Zero-drama updates**: push to `main` → CI (typecheck, lint, 329 unit/integration,
  the full E2E suite) → GitHub Release → banner on the office PC → Admin clicks once →
  the supervisor swaps versions with a health gate and automatic rollback. **Business
  data is never part of an update.**
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
