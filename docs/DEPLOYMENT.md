# Deployment & Operations

> Fleshed out across Phases 1 and 11. This documents the target design now so ops decisions
> are visible early.

## Topology

```
[phones/tablets/laptops anywhere]
        │ https
[Cloudflare Tunnel]  ← free account; no router ports opened; hides office IP
        │
[Office Windows PC]
  WinSW service  →  supervisor.cjs  →  node releases\v1.0.N\server\dist\index.js
                                        │
  C:\bharti\data\  (app.db, uploads\, backups\)   ← NEVER touched by updates
```

## Install layout (office PC)

```
C:\bharti\
  supervisor\supervisor.cjs   installed once, never auto-updated
  supervisor\config.json      port, repo, poll interval
  current.txt                 pointer to active release, e.g. "v1.0.43"
  releases\v1.0.42\           immutable: server\dist, client-dist, node_modules, version.json
  releases\v1.0.43\
  data\                       app.db, uploads\, backups\
  logs\
```

## Update lifecycle

1. Developer pushes to `main` → CI tests → `release.yml` builds zip on windows-latest →
   GitHub Release `v1.0.<run>`.
2. Running app polls the GitHub releases API (~15 min) → "Update available" banner for all
   users; **Update now** button for Admin.
3. On click: app downloads + sha256-verifies + extracts zip to `releases\<new>\` while still
   serving → writes `pending-update.json` → drains, checkpoints WAL, exits **code 42**.
4. Supervisor: backs up `data\app.db*` → atomically flips `current.txt` → starts new version
   → new version migrates (additive-only) then binds → supervisor health-checks (60s).
5. **Failure ⇒ automatic rollback**: flip pointer back, restore DB backup, start previous
   release, surface `rolled_back` in the UI.

Manual fallback: download the Release zip by hand, extract into `releases\`, edit
`current.txt`, restart the service.

## Backups

- Daily 02:00 IST `db.backup()` → `data\backups\daily-YYYY-MM-DD.db` (keep 30).
- Pre-update copy → `data\backups\pre-update-<version>\`.
- Admin UI: list + download + on-demand backup. Restore = stop service, replace
  `data\app.db`, start service (documented in runbook, Phase 11).

## To be written in Phase 11

- Step-by-step office-PC install (Node 24 pin, service install, first admin).
- Cloudflare Tunnel setup with copy-paste commands.
- Runbook: restore drill, log locations, common failures.
