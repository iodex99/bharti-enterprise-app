# Progress

> **Read this first in a new session.** It is the single source of truth for where the
> build stands. Update it at every phase gate and whenever direction changes.

## Phase checklist

- [x] **Phase 0 — Scaffold**: monorepo (server/client/shared), TS strict, eslint/prettier,
  Vitest + Playwright wiring, Express serves Vite build, docs tree, CI skeleton, first push.
- [x] **Phase 1 — Deploy + self-update rails**: release.yml (windows-latest → GitHub Release
  zip + checksums), supervisor.cjs (exit-42/43 protocol, health gate, crash-loop rollback,
  DB backup/restore, release pruning), WinSW config + install-service.ps1, update
  banner/status UI, scripts/update-drill.mjs (boot → one-click update → poisoned-release
  auto-rollback, all against a mock GitHub feed). **Repo is PRIVATE** → update polling uses
  an optional PAT (supervisor config.json `githubToken` → env BHARTI_GITHUB_TOKEN; API asset
  URLs + octet-stream for downloads).
- [x] **Phase 2 — DB core**: 001_init.sql full schema (all modules), transactional
  additive-only migration runner (boot-time, pre-migrate backup, exit 43 on failure),
  sessions auth (httpOnly cookie, sliding 12h, lockout, rate limit), RBAC middleware +
  exhaustive matrix test, audit service, users admin (create/edit/deactivate/reset with
  instant session revocation), backups (daily 2AM IST cron + manual + download UI),
  audit log UI, seed script, login/shell/users/audit/backups pages, E2E (auth, forced
  password change, RBAC walls, mobile + desktop).
- [x] **Phase 3 — Masters ×6**: generic masters service (audited CRUD, soft-delete blocked
  while referenced, deactivate hides from new use), admin-only mutations / all-role reads,
  image pipeline (multer→sharp→webp in data/uploads, auth-gated serving, traversal-safe),
  config-driven MastersPage ×6, DataTable + MoneyInput + ImageInput components, masters E2E.
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

Phases 0–3 complete. 128 unit/integration tests + 20 E2E tests green. Update drill
13/13 (seeded install → admin one-click update → session & data survive → poisoned
release auto-rolls-back with DB restore). CI on GitHub (ubuntu + windows) runs
typecheck/lint/test/build + E2E; release.yml publishes `v1.0.<run>` zips from green main.

**Environment quirks discovered (don't relearn these):**
- Repo `iodex99/bharti-enterprise-app` is **private** — unauthenticated GitHub API gets 404;
  git push works via Git Credential Manager. Office installs need a fine-grained PAT
  (Contents: read) in supervisor config.json.
- Windows: use `C:\Windows\System32\tar.exe` (bsdtar) explicitly for zip create/extract —
  PATH `tar` may be Git's GNU tar (no zip support).
- Playwright 1.61 starts `webServer` CONCURRENTLY with globalSetup → seed inside the
  webServer command (scripts/e2e-server.mjs), never in globalSetup.
- Playwright runs desktop then mobile projects against ONE server/DB: per-project usernames
  (`fresh-desktop`/`fresh-mobile`), LOGIN_MAX_PER_MINUTE raised in E2E env.
- In-app login rate limit is env-tunable (`LOGIN_MAX_PER_MINUTE`, default 10/min/IP).

## Next steps

1. **Phase 4 — Ledger engine**: `ledger.service.ts` (post movements inside sync
   transactions, per-lot negative-balance guard, FIFO consumer, genesis/terminal ref_type
   whitelists per docs/DATA_MODEL.md), conservation invariant test suite, purchases module
   (+void with reversals, image), RAW stock views, opening balances (admin), DzPc/Meters
   date inputs, idempotency-key middleware for document posts.
2. Then Phase 5 (cutting).

## Session notes

- 2026-07-10: project started; plan approved; Phases 0–2 built and verified. First push done
  (CI green on GitHub). Release pipeline live: every push to main publishes v1.0.<run_number>.
