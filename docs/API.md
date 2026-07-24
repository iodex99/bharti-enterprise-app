# API Reference

All endpoints under `/api`, session-cookie auth, zod-validated bodies, audited mutations.
Roles: **A**dmin, **O**perator, **W**=owner (read-only). `anon` = no session.
Document-creating POSTs accept an optional `Idempotency-Key` header (replays return the
original id with `replayed: true`).

**Office scoping (ADR-028):** every document/stock/report endpoint works within ONE
office. Operators are pinned server-side to `users.office_id`; admin/owner select the
office per request with the `X-Office-Id` header (default 1; the client stores the choice
in localStorage and reloads on switch). Lengths are integer hundredths-of-an-inch
("inch_c", 1 yd = 3600 — ADR-029).

### System
| Method | Path | Roles | Notes |
|---|---|---|---|
> **Device-specific endpoints.** Updates, backups, restore and demo mode are marked
> **(device)** below. On the Node host they are Express routes
> (`routes/system.node.routes.ts`); in the Android app the same URLs are answered on the
> UI thread by `client/src/local/native-ops.ts`, because they need the app shell, storage
> and the share sheet. Request and response shapes are identical, so the screens are the
> same code.

| GET | /api/system/health | anon | `{ ok, version, uptimeSeconds, demoMode }` — supervisor health gate |
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
| POST | /api/system/update-apk | A | **(device)** hand the release APK to Android's installer |
| DELETE | /api/system/update-rollback-notice | A | **(device)** acknowledge an automatic rollback |

### Auth & users
| Method | Path | Roles |
|---|---|---|
| POST /api/auth/login (rate-limited) · POST /logout · GET /me · POST /change-password | | anon/all |
| GET/POST /api/users · PATCH /:id · POST /:id/{deactivate,reactivate,reset-password} | | A |
| GET /api/audit?entityType&entityId&limit&offset | | A |

### Masters — /api/masters/{colors,sizes,vendors,contractors,staff}
GET (all roles) · POST, PUT /:id, POST /:id/{deactivate,reactivate}, DELETE /:id (A only;
delete blocked while referenced). `models` is GONE from masters (ADR-030) — product codes
are typed at cutting; pickers read **GET /api/products** (all roles; code + photo, sorted,
RAW-CLOTH sentinel excluded).

### Offices — /api/offices
GET (all roles; `?includeInactive=1` for admin) · POST, PUT /:id (A only; office 1 cannot
be deactivated). Creating users: operators REQUIRE `officeId`; changing a user's office
revokes their sessions.

### Uploads
POST /api/uploads (A O, multipart `image` → webp path) · GET /uploads/* (all roles).
Bytes are stored in `upload_files` (migration 003), not on disk; the path format is
unchanged. In the Android app the picked file is passed straight to the in-app server, and
the resize/re-encode runs on OffscreenCanvas instead of sharp.

### Transactions
| Path | Create | Extra endpoints | Void |
|---|---|---|---|
| /api/purchases | A O — vendor+color+{lenInchC, widthInchC, ratePaisePerYard}, NO code (given at cutting) | PUT /:id (financial fields only) | A, blocked after cutting |
| /api/opening-balances | A — RAW takes widthInchC + no code; other stages take a typed `modelCode` | | A, blocked after consumption |
| /api/cutting | A O — per-line {sizeId, code, qtyPcs, clothPerPcInchC, widthCount, imagePath?}; the entry IS the cutting (consumes RAW + creates CUT, ADR-031) | PUT /:id, DELETE /:id — while nothing is issued downstream; doc number kept | A, blocked after issue |
| /api/jobs | A O — lines carry {modelId, colorId, sizeId, qty, ratePaisePerDozen}; returns `{cards:[…]}`, ONE card per code+color (ADR-033) | PUT /:id, DELETE /:id (receipt-less cards), POST /:id/receipts (partial/excess/unstitched; **imagePath REQUIRED**, ADR-032), POST /:id/close (A) | A, unstarted only |
| /api/checking | A O — directed: {staffId, lotType, lotId, qtyPcs} names the received batch | GET /pending (batches waiting w/ contractor+photo), POST /:id/results ({qtyPassed, rejections:[{reason, qtyPcs}]} — 'missing' is a reason, ADR-034), POST /:id/pack (allot passed pcs to a packer or keep a labeled bundle, ADR-035) | A, before results |
| /api/packing | A O — directed at {lotType ∈ check_issue\|opening\|pack_issue(bundle), lotId}; kind pack\|bundle + label | GET ?kind=, POST /:id/results (packed/short sessions) | A, before results |
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
| GET /api/contractors/dues | pending dues per contractor (ADR-036) |
| GET /api/products | product codes for pickers (typed at cutting) |
| GET /api/reports · /api/reports/:key?filters&format=xlsx | 16-report registry; xlsx export |
| GET /api/reports/full?from&to&format=html|xlsx | Complete Business Report (styled HTML / multi-sheet workbook) |
| GET /api/trace/fg-lots · /fg/:packIssueId · /purchase/:purchaseId | traceability trees |
| GET /api/dashboard · /api/dashboard/alerts | owner dashboard + alert feed |
