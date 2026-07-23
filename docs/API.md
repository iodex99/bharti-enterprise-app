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
| GET/POST | /api/system/backups | A | list / run now (+cloudDir, lastDailyBackupDate) |
| POST | /api/system/backups/sync | A | copy DB backups into the cloud-synced folder |
| GET | /api/system/backups/download?name= | A | download one daily/manual `.db` |
| GET | /api/system/backups/complete | A | download a complete snapshot (.zip: DB + photos + manifest); 409 in demo |
| POST | /api/system/backups/complete-to-cloud | A | write a complete snapshot into the cloud folder |
| GET | /api/system/restore/candidates | A | complete snapshots found in the cloud folder |
| POST | /api/system/restore/upload | A | multipart `backup`; parks the file, returns {token, manifest, compatible} |
| POST | /api/system/restore/commit | A | `{token}` or `{cloudName}` → atomic swap + auto-rollback; clears sessions; 409 in demo |
| GET | /api/system/setup-state | A O W | `{ needsSetup }` — fresh-install wizard gate |
| POST | /api/system/setup/complete | A | dismiss the setup wizard |

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
| /api/purchases | A O — vendor+color+meters, NO model (decided at cutting) | PUT /:id (financial fields only) | A, blocked after cutting |
| /api/opening-balances | A — RAW takes no model | | A, blocked after consumption |
| /api/cutting | A O — modelId + per-line {clothPerPcInchC, widthCount}; consumption computed | PUT /:id (re-plan while 'planned'), DELETE /:id (planned only, soft), POST /:id/actuals (variance reasons enforced) | A, blocked after issue |
| /api/jobs | A O | POST /:id/receipts (partial/excess/unstitched, optional imagePath photo), POST /:id/close (A) | A, unstarted only |
| /api/checking | A O — directed: {staffId, lotType, lotId, qtyPcs} names the received batch | GET /pending (batches waiting w/ contractor+photo), POST /:id/results (pass/reject/missing sessions) | A, before results |
| /api/packing | A O (any active staff — no roles) | POST /:id/results (packed/short sessions) | A, before results |
| /api/dispatches | A | | A (ledger replay) |
| /api/contractors/payments | A O | | A |

### Discrepancies (review workflow)
| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | /api/discrepancies | A O W | all recorded differences with source doc, item, party; unresolved first |
| POST | /api/discrepancies/:id/resolve | A | `{ note }` — acknowledgement only, never a stock movement; 409 if already resolved |

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
