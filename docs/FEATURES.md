# Feature Matrix

Status: ✅ done · 🚧 in progress · ⬜ planned

| Module | Status | Notes |
|---|---|---|
| Monorepo scaffold + CI | ✅ | Phase 0 |
| Self-update (supervisor, releases, banner) | ✅ | Phase 1 |
| Auth, sessions, RBAC, audit | ✅ | Phase 2 |
| Users admin | ✅ | Phase 2 |
| Masters: Colors / Sizes / Vendors / Contractors / Staff (Models removed → v2) | ✅ | Phase 3, v2 |
| Image uploads (model refs, purchase refs) | ✅ | Phase 3 |
| Stock ledger engine (7 stages) | ✅ | Phase 4 |
| Raw material purchases + RAW stock | ✅ | Phase 4 |
| Opening balances | ✅ | Phase 4 |
| Void-with-reversals | ✅ | Phase 4 |
| Cutting plan/actual + variance + CUT stock | ✅ | Phase 5 |
| Job cards + partial receipts + discrepancies + WIP | ✅ | Phase 6 |
| Contractor analytics + rankings | ✅ | Phase 6 |
| Contractor payments (dues, statements) | ✅ | Phase 6 |
| Checking (pass/reject/missing) + REJECTED stage | ✅ | Phase 7 |
| Packing + FG inventory + dispatch | ✅ | Phase 7 |
| Traceability tree (FG ↔ vendor) | ✅ | Phase 8 |
| Reports (~15) + Excel export + print | ✅ | Phase 8 |
| Dashboard + alerts | ✅ | Phase 9 |
| Discrepancy review page + admin resolve (acknowledgement-only) | ✅ | post-ship |
| Complete backup (DB+photos zip) + one-click download + send-to-Drive | ✅ | post-ship |
| In-app restore (atomic swap + auto-rollback) + first-run setup wizard | ✅ | post-ship |
| Model decided at cutting (purchases are vendor+color+meters) | ✅ | post-ship |
| Cutting geometry: inches/pc × width count → computed consumption + remaining | ✅ | post-ship |
| Cutting plan edit + delete (while planned) | ✅ | post-ship |
| Pending-for-checking pool + directed checker allotment (contractor mapping) | ✅ | post-ship |
| Receipt photos (returned goods) | ✅ | post-ship |
| Staff either-or (no fixed checker/packer roles) | ✅ | post-ship |
| Register ink colors (blue = issued out, red = received in) | ✅ | post-ship |
| **Android app: whole system on one device (no server)** | ✅ | app pivot |
| SQLite-WASM on OPFS + in-app server in a worker | ✅ | app pivot |
| Photos stored in the database (one file = whole business) | ✅ | app pivot |
| One-tap in-app update (verify → swap → restart) | ✅ | app pivot |
| Automatic rollback when an update will not start | ✅ | app pivot |
| APK path when the native shell changes (minNativeVersion) | ✅ | app pivot |
| Backup/restore + move-to-a-new-device via Android share sheet | ✅ | app pivot |
| Demo mode on the device (second database) | ✅ | app pivot |
| PWA install + polish | ✅ | Phase 10 |
| Backups (daily + pre-update + UI) | ✅ | Phase 2 |
| Deployment docs (WinSW + Cloudflare Tunnel) | ✅ | Phase 11 |
| **Back to the central-PC web app (Android dormant)** | ✅ | v2 (ADR-027) |
| Multi-office: offices admin, per-office data + doc numbers, operator pinning, office switcher | ✅ | v2 (ADR-028) |
| Cloth in yards + width (inch_c integers; rate per yard) | ✅ | v2 (ADR-029) |
| Code number typed at cutting + product photo → "size-code" everywhere | ✅ | v2 (ADR-030) |
| Cutting is final (no actuals); edit/delete until issued | ✅ | v2 (ADR-031) |
| Job receipts require a photo of the returned goods | ✅ | v2 (ADR-032) |
| Combined issue → one job card per code+color; job edit/delete; cost per dozen at issue | ✅ | v2 (ADR-033) |
| Checking: single rejected box, 'missing' as a dropdown reason | ✅ | v2 (ADR-034) |
| Packing from the checking row (checker packs by default); labeled bundles kept aside | ✅ | v2 (ADR-035) |
| Pending dues view + report | ✅ | v2 (ADR-036) |
| Checker/packer rates per dozen + earnings + dues | ✅ | v3 (ADR-037) |
| Payment QR codes on contractor + staff masters (shown when paying) | ✅ | v3 (ADR-037) |
| Record payments on the Dues page (partial, dated; contractors AND staff) | ✅ | v3 (ADR-037) |
| Client's default sizes HR / PIPE / JUMBO in seed + demo | ✅ | v3 |
