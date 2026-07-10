# API Reference

> Updated with every route change. All endpoints under `/api`. Auth via session cookie.
> Mutations require `Origin` matching and role permission (see RBAC below).

## Implemented

### System
| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | /api/system/health | public | `{ ok, version, uptimeSeconds }` |
| GET | /api/system/version | public | `{ version }` |

## Planned route groups (built per phase)

- `/api/auth` — login, logout, me, change-password (Phase 2)
- `/api/users` — admin CRUD + activate/deactivate + reset password (Phase 2)
- `/api/masters/{models,colors,sizes,vendors,contractors,staff}` (Phase 3)
- `/api/purchases` + `:id/void` (Phase 4)
- `/api/opening-balances` (Phase 4)
- `/api/cutting` — plan, actuals (Phase 5)
- `/api/jobs` — cards, receipts, close (Phase 6)
- `/api/contractors/:id/{analytics,payments,statement}` (Phase 6)
- `/api/checking`, `/api/packing`, `/api/dispatches` (Phase 7)
- `/api/stock/{raw,cut,wip,checking,packing,fg,rejected,lots}` (Phases 4–7)
- `/api/trace/*` (Phase 8)
- `/api/reports/*` — all support `?format=xlsx` (Phase 8)
- `/api/dashboard`, `/api/alerts` (Phase 9)
- `/api/audit` (Phase 2)
- `/api/system/{update-check,update,update-status,backups}` (Phases 1–2)

## RBAC summary

- **admin** — everything.
- **operator** — create/read transactions + masters; NO delete/void/override/users/
  settings/update/adjustments; cannot modify completed documents.
- **owner** — GET only (dashboard, reports, stock, masters, trace).
- **anon** — health/version + login only.
