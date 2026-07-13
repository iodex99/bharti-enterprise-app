# Decisions (ADR log)

One line per locked decision; expand only when the reasoning is non-obvious.

- **ADR-001** Stack: Node 24 + Express 5 + better-sqlite3 + React 19 + Vite + Tailwind 4.
  Single office-PC deployment → single-file DB, one port, no external services.
- **ADR-002** All quantities stored as integers: pieces (1dz=12), cm, paise. Floats banned
  from the DB; conversions centralized in `shared/src/units.ts`.
- **ADR-003** Single `stock_ledger` table for all 7 stages (not per-stage tables);
  balances via SUM; per-stage SQL views for reporting.
- **ADR-004** Server-side sessions (not JWT): single server, instant revocation on user
  deactivation; httpOnly SameSite=Lax cookie.
- **ADR-005** Self-update via supervisor + immutable side-by-side releases + CI-built
  GitHub Release zips (NOT PM2 + git pull: Windows file locks and process-tree kills make
  in-place updates unreliable). Exit code 42 = apply staged update, 43 = migration failure.
- **ADR-006** Migrations additive-only, run at boot, transactional, DB backed up first;
  enables safe automatic rollback to the previous release.
- **ADR-007** Batch lineage: explicit batch selection at cutting only; FIFO auto-allocation
  at every downstream hop (job/check/pack allocations tables). Documented as an honest
  approximation of physically mixed bins.
- **ADR-008** Raw SQL + thin typed repositories, no ORM: ledger-centric app, hand-rolled
  additive migrations.
- **ADR-009** Requests validated with zod schemas shared between server and client
  (`@shared` path alias; no build step for the shared folder).
- **ADR-010** Business dates are user-entered `YYYY-MM-DD` strings (backdating allowed,
  reports filter on them); `created_at` UTC ISO timestamps are the audit truth.
- **ADR-011** Minimal FG dispatch (admin-only stock-out) ships in v1 so finished-goods
  inventory can decrease; the full sales module stays on the roadmap.
- **ADR-012** Supervisor is CommonJS (`supervisor.cjs`), zero npm dependencies, installed
  once, never auto-updated — it must survive any app-release bug.
- **ADR-013** Resolving a discrepancy is an acknowledgement (admin-only note + who/when),
  NEVER a stock movement — the ledger effect already happened when the difference was
  recorded. Keeps the review workflow unable to corrupt inventory.
