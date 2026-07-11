# API Reference

All endpoints under `/api`, session-cookie auth, zod-validated bodies, audited mutations.
Roles: **A**dmin, **O**perator, **W**=owner (read-only). `anon` = no session.
Document-creating POSTs accept an optional `Idempotency-Key` header (replays return the
original id with `replayed: true`).

### System
| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | /api/system/health | anon | `{ ok, version, uptimeSeconds }` — supervisor health gate |
| GET | /api/system/version | anon | |
| GET | /api/system/update-status | A O W | update state machine + versions |
| GET | /api/system/update-check | A O W | forces a release-feed poll |
| POST | /api/system/update | A | 202 download→stage→restart; 400 dev/no-update; 409 busy |
| GET | /api/system/reconciliation | A | live ledger conservation checks |
| GET/PUT | /api/system/settings | A | whitelisted keys (delayed_job_days) |
| GET/POST | /api/system/backups | A | list / run now (+cloudDir in listing) |
| POST | /api/system/backups/sync | A | copy backups into the cloud-synced folder |
| GET | /api/system/backups/download?name= | A | |

### Auth & users
| Method | Path | Roles |
|---|---|---|
| POST /api/auth/login (rate-limited) · POST /logout · GET /me · POST /change-password | | anon/all |
| GET/POST /api/users · PATCH /:id · POST /:id/{deactivate,reactivate,reset-password} | | A |
| GET /api/audit?entityType&entityId&limit&offset | | A |

### Masters — /api/masters/{models,colors,sizes,vendors,contractors,staff}
GET (all roles) · POST, PUT /:id, POST /:id/{deactivate,reactivate}, DELETE /:id (A only;
delete blocked while referenced).

### Uploads
POST /api/uploads (A O, multipart `image` → webp path) · GET /uploads/* (all roles).

### Transactions
| Path | Create | Extra endpoints | Void |
|---|---|---|---|
| /api/purchases | A O | PUT /:id (financial fields only) | A, blocked after cutting |
| /api/opening-balances | A | | A, blocked after consumption |
| /api/cutting | A O | POST /:id/actuals (variance reasons enforced) | A, blocked after issue |
| /api/jobs | A O | POST /:id/receipts (partial/excess/unstitched), POST /:id/close (A) | A, unstarted only |
| /api/checking | A O | POST /:id/results (pass/reject/missing sessions) | A, before results |
| /api/packing | A O | POST /:id/results (packed/short sessions) | A, before results |
| /api/dispatches | A | | A (ledger replay) |
| /api/contractors/payments | A O | | A |

### Read models
| Path | Notes |
|---|---|
| GET /api/stock/summary · /raw · /:stage | live inventory (all roles) |
| GET /api/jobs?status&contractorId · /api/jobs/:id/receipts | job list with per-line settlement |
| GET /api/contractors/analytics | performance + dues |
| GET /api/reports · /api/reports/:key?filters&format=xlsx | 15-report registry; xlsx export |
| GET /api/reports/full?from&to&format=html|xlsx | Complete Business Report (styled HTML / multi-sheet workbook) |
| GET /api/trace/fg-lots · /fg/:packIssueId · /purchase/:purchaseId | traceability trees |
| GET /api/dashboard · /api/dashboard/alerts | owner dashboard + alert feed |
