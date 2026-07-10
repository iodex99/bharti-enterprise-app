# Changelog

Newest first. Every meaningful change gets a line. CI release notes are generated from
commit messages; this file is the human-curated history.

## Unreleased

- 2026-07-10 — Phase 3: all six masters (generic audited CRUD service; unique-name/code
  409s; soft delete blocked while referenced with "deactivate instead" guidance; admin-only
  mutations, all roles read), image upload pipeline (sharp → webp 1600px, EXIF stripped,
  auth-gated /uploads serving, traversal-safe), config-driven masters UI with DataTable,
  MoneyInput (₹→paise), ImageInput; masters integration suite + E2E. Update drill upgraded
  for the auth era and passing 13/13 incl. session survival across updates.

- 2026-07-10 — Phase 2: complete schema v1 (masters, documents, stock_ledger, allocations,
  audit, sessions), boot-time transactional migrations with pre-migrate backup + exit-43
  protocol, session auth (lockout, rate limit, sliding expiry), RBAC + exhaustive matrix
  test, audit trail service + admin UI, user management with instant session revocation,
  daily/manual backups + download UI, seed script, login + app shell + admin pages,
  auth E2E incl. forced password change (110 unit/integration + 16 E2E tests).
- 2026-07-10 — Phase 1: self-update pipeline — release.yml builds win32 zips on green main
  → GitHub Releases; zero-dep supervisor.cjs applies staged updates (exit 42), health-gates
  new releases, auto-rolls-back on boot failure/crash-loop WITH database restore; WinSW
  service config + office installer script; in-app update banner + one-click Update Now
  (admin) + status polling through restart; private-repo PAT support; full local drill
  script proving update + rollback against a mock feed.
- 2026-07-10 — Phase 0: monorepo scaffold (Express 5 + React 19 + Tailwind 4 + better-sqlite3
  stack), shared unit/enum/version helpers with unit tests, health endpoint + integration test,
  Playwright smoke E2E, ESLint/Prettier/TS-strict, CI skeleton, living docs tree.
