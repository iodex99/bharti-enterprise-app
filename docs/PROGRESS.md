# Progress

> **Read this first in a new session.** It is the single source of truth for where the
> build stands. Update it at every phase gate and whenever direction changes.

## Phase checklist

- [x] **Phase 0 — Scaffold**: monorepo (server/client/shared), TS strict, eslint/prettier,
  Vitest + Playwright wiring, Express serves Vite build, docs tree, CI skeleton, first push.
- [ ] **Phase 1 — Deploy + self-update rails**: release.yml → GitHub Release zip;
  supervisor.cjs (exit-42/43 protocol, rollback); WinSW config; update banner/button/status UI;
  local update-loop drill incl. forced rollback.
- [ ] **Phase 2 — DB core**: migration runner + 001_init.sql full schema, seed, backup cron,
  auth/sessions/lockout, RBAC matrix, audit service, users admin UI.
- [ ] **Phase 3 — Masters ×6** + image pipeline + client shell (DataTable, FormModal,
  DzPc/Money/Date inputs, nav, role gating).
- [ ] **Phase 4 — Ledger engine** + conservation tests + purchases (+void) + RAW stock +
  opening balances.
- [ ] **Phase 5 — Cutting**: plan → actuals, variance + reasons, CUT stock.
- [ ] **Phase 6 — Job work**: cards+lines, FIFO allocations, partial/excess/unstitched
  receipts, discrepancies, admin close, WIP stock, contractor analytics + payments.
- [ ] **Phase 7 — Checking + Packing + FG** + dispatch + REJECTED stage; full-chain
  conservation test.
- [ ] **Phase 8 — Traceability tree + reports (~15) + Excel export + print CSS.**
- [ ] **Phase 9 — Dashboard (KPIs + charts) + alerts panel.**
- [ ] **Phase 10 — PWA + polish + nightly self-reconciliation.**
- [ ] **Phase 11 — Hardening**: full E2E, security sweep, backup/restore + rollback drills,
  USER_GUIDE, DEPLOYMENT (office PC + WinSW + Cloudflare Tunnel), final release.

## Current state

Phase 0 complete: workspaces install/build/test green locally; hello-world client served
by Express; smoke E2E passing; CI skeleton pushed.

## Next steps

1. Phase 1: write `release.yml` (windows-latest zip → GitHub Release), `supervisor/supervisor.cjs`,
   update service + banner UI, local mock-feed update drill + forced rollback drill.

## Session notes

- 2026-07-10: project started; plan approved (see `~/.claude/plans/i-want-to-make-ticklish-lemon.md`,
  mirrored into these docs); Phase 0 scaffolded.
