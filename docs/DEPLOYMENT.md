# Deployment & Operations

## Topology

```
[phones/tablets/laptops anywhere]
        │ https
[Cloudflare Tunnel]  ← free; no router ports opened; hides the office IP
        │
[Office Windows PC]
  WinSW service → supervisor.cjs → node releases\v1.0.N\server\dist\index.js
                                     │
  C:\bharti\data\  (app.db, uploads\, backups\)   ← NEVER touched by updates
```

## One-time office PC installation

Prerequisites on the office PC:
1. **Node.js 24 LTS** — https://nodejs.org (Windows installer, default options).
2. A **GitHub fine-grained personal access token** for the private repo
   (`iodex99/bharti-enterprise-app`): GitHub → Settings → Developer settings →
   Fine-grained tokens → generate with **Repository access: this repo** and
   **Permissions → Contents: Read-only**. Copy the token.

Then, in an **elevated PowerShell** (Run as administrator), from a copy of this repo's
`scripts/` folder (or a checkout):

```powershell
powershell -ExecutionPolicy Bypass -File install-service.ps1 `
  -Root C:\bharti -Port 8787 -GithubToken "github_pat_XXXX"
```

The installer:
- creates `C:\bharti\{supervisor,releases,data,logs,service}`,
- copies `supervisor.cjs` and writes `supervisor\config.json` (port, repo, token),
- downloads the **latest GitHub Release zip** and extracts it to `releases\<version>`,
- installs and starts the **bharti-app** Windows service (WinSW) wrapping the supervisor.

Open `http://localhost:8787` — sign in with the initial admin credentials from
`C:\bharti\data\initial-admin-password.txt` (created on first boot; the password must be
changed at first sign-in, then delete the file).

## Remote access — Cloudflare Tunnel (recommended)

1. Create a free Cloudflare account and add a domain (a cheap/existing one; the tunnel
   needs a zone to attach a hostname to).
2. On the office PC (elevated PowerShell):

```powershell
winget install Cloudflare.cloudflared
cloudflared tunnel login                 # opens the browser to authorize
cloudflared tunnel create bharti
cloudflared tunnel route dns bharti app.YOURDOMAIN.com
```

3. Create `C:\Users\<user>\.cloudflared\config.yml`:

```yaml
tunnel: bharti
credentials-file: C:\Users\<user>\.cloudflared\<TUNNEL-ID>.json
ingress:
  - hostname: app.YOURDOMAIN.com
    service: http://localhost:8787
  - service: http_status:404
```

4. Install it as a service so it survives reboots:

```powershell
cloudflared service install
Start-Service cloudflared
```

Staff now reach the app at `https://app.YOURDOMAIN.com` from anywhere. The app already
sets `trust proxy` and secure cookies behind https.

*Alternatives:* **Tailscale** (simplest private option — install on the PC and every
user device, share the tailnet, use `http://<pc-name>:8787`) or router **port
forwarding + dynamic DNS** (not recommended: exposes the office IP directly).

## How updates flow

1. Developer pushes to `main` → GitHub Actions runs the full test suite → `release.yml`
   builds the Windows zip → publishes Release `v1.0.<run>`.
2. The running app polls the releases API every 15 min → every user sees the
   "Update available" banner; **Admin** presses *Update now*.
3. The app downloads + sha256-verifies + stages the release, then hands over (exit 42).
   The supervisor backs up the database, flips `current.txt`, starts the new version and
   health-checks it.
4. **Any failure → automatic rollback** to the previous release including the database
   copy. The UI reports success or rollback either way. Old releases are pruned (last 3 kept).

Manual fallback (GitHub down / token expired): download the Release zip on any machine,
copy it over, extract to `C:\bharti\releases\v1.0.N\`, write that version into
`C:\bharti\current.txt`, then `Restart-Service bharti-app`.

## Backups & restore

- Automatic: daily 02:00 IST (`data\backups\daily-*.db`, keep 30) + a pre-update copy
  before every version change.
- Manual: Administration → Backups → *Backup now* / *Download*. **Take a copy off the
  office PC weekly** (pen drive or cloud drive).
- **Restore drill:** stop the service (`Stop-Service bharti-app`), replace
  `C:\bharti\data\app.db` with the chosen backup file (delete `app.db-wal`/`app.db-shm`
  if present), start the service, verify System Health shows all checks ✅.

## Runbook

| Symptom | Do this |
|---|---|
| App unreachable locally | `Get-Service bharti-app` → start it; check `C:\bharti\logs\supervisor.log` and `app.log` |
| Unreachable remotely only | `Get-Service cloudflared` → start; check tunnel status in Cloudflare dashboard |
| Update banner never appears | Token expired? Update `supervisor\config.json` → `githubToken`, restart service |
| Update failed | Nothing to do — it rolled back automatically; check `update-status.json` + logs, fix, push a new release |
| "Inventory self-check" shows ❌ | Stop entering data, take a manual backup, contact the developer |
| Disk filling up | Old zips in `C:\bharti\tmp`, old releases beyond 3, `data\backups` — all safe to trim |

Recommended: attach a small UPS to the office PC (the database is power-loss safe by
configuration, but the UPS avoids interrupted work sessions).

## Go-live checklist

1. ☐ Office PC: Node 24 installed, service installed via `install-service.ps1`, app
   answers on `http://localhost:8787`.
2. ☐ Initial admin password changed; `initial-admin-password.txt` deleted.
3. ☐ Cloudflare Tunnel up; app reachable from a phone on mobile data (not office Wi-Fi).
4. ☐ Users created (operators + owner) with temporary passwords; each signed in once.
5. ☐ Masters entered: models, colors, sizes, vendors, contractors, checkers/packers.
6. ☐ **Opening balances** entered from the registers (Admin → Opening Balances) for all
   stages that hold stock; Inventory page matches the physical count.
7. ☐ System Health: every self-check ✅.
8. ☐ Backup taken (Backups → Backup now) and a copy stored off the PC.
9. ☐ Update drill on the real install: push a trivial change → banner appears →
   *Update now* → new version live, data intact.
10. ☐ Restore drill rehearsed once (stop service, swap DB from backup, start, verify).
11. ☐ Staff walked through docs/USER_GUIDE.md on their own phones.
