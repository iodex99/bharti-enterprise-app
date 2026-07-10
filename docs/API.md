# API Reference

> Updated with every route change. All endpoints under `/api`. Auth via session cookie.
> Mutations require `Origin` matching and role permission (see RBAC below).

## Implemented

### System
| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | /api/system/health | public | `{ ok, version, uptimeSeconds }` |
| GET | /api/system/version | public | `{ version }` |
| GET | /api/system/update-status | any signed-in | update state machine + latest/current versions |
| GET | /api/system/update-check | any signed-in | forces a poll of the release feed |
| POST | /api/system/update | admin | 202 starts download→stage→restart; 400 dev/no-update; 409 busy |
| GET | /api/system/backups | admin | list daily/manual/pre-update backups |
| POST | /api/system/backups | admin | run a manual backup now |
| GET | /api/system/backups/download?name= | admin | download a backup file |

### Auth
| Method | Path | Roles | Notes |
|---|---|---|---|
| POST | /api/auth/login | public (rate-limited) | sets httpOnly session cookie; 423 when locked |
| POST | /api/auth/logout | signed-in | revokes session |
| GET | /api/auth/me | signed-in | `{ user }` incl. mustChangePassword |
| POST | /api/auth/change-password | signed-in | revokes other sessions |

### Users (admin only)
| Method | Path | Notes |
|---|---|---|
| GET | /api/users | list |
| POST | /api/users | create (username unique, temp password, must-change) |
| PATCH | /api/users/:id | displayName/role; role change revokes sessions |
| POST | /api/users/:id/deactivate | revokes sessions instantly; cannot self-deactivate |
| POST | /api/users/:id/reactivate | |
| POST | /api/users/:id/reset-password | temp password + must-change + revoke sessions |

### Audit (admin only)
| Method | Path | Notes |
|---|---|---|
| GET | /api/audit?limit&offset&entityType&entityId | newest first, old/new JSON |

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
