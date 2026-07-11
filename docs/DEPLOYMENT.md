# Deployment & Operations

## Topology

```
[phones/tablets/laptops anywhere, signed into Tailscale]
        │ https (tailscale serve — no domain, no open ports)
[Office Windows PC]
  WinSW service → supervisor.cjs → node releases\v1.0.N\server\dist\index.js
                                     │
  C:\bharti\data\        (app.db, uploads\, backups\)  ← NEVER touched by updates
  C:\bharti\data-demo\   (demo database — buttons in Admin → System Health)
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

## Remote access — Tailscale (recommended: NO domain needed)

The business has no domain, so Tailscale is the best fit: free, very secure (the app is
never exposed to the public internet at all), and it provides HTTPS automatically.

**On the office PC** (elevated PowerShell):

```powershell
winget install Tailscale.Tailscale
tailscale up            # opens the browser — sign in with ONE account for the business
                        # (a Google account works; every device uses this same account)
tailscale serve --bg localhost:8787
tailscale dns status    # note the machine's name, e.g. office-pc.tail1a2b3c.ts.net
```

`tailscale serve` gives the app a real **https://office-pc.tail1a2b3c.ts.net** address
with a valid certificate — so the phone-app install (PWA) and secure cookies work
exactly as they would on a domain. (If the HTTPS feature prompts you, enable
**MagicDNS + HTTPS certificates** once in the Tailscale admin console → DNS.)

**On each staff phone/laptop:** install the Tailscale app (Play Store / App Store /
tailscale.com/download), sign in with the **same business account**, switch the VPN
toggle on, then open `https://office-pc.tail1a2b3c.ts.net` in the browser and
"Add to Home Screen". The free plan comfortably covers a small team's devices under
one account. Devices NOT signed into Tailscale simply cannot reach the app at all —
that's the security model.

### Alternatives

- **Cloudflare Tunnel** — better *if the business ever buys a domain* (any ~₹100–800/yr
  domain works): no per-device app needed, staff just open a normal https link.
  Setup: `winget install Cloudflare.cloudflared`, `cloudflared tunnel login`,
  `cloudflared tunnel create bharti`, `cloudflared tunnel route dns bharti app.DOMAIN`,
  config.yml pointing at `http://localhost:8787`, `cloudflared service install`.
- **Cloudflare Quick Tunnel** (`cloudflared tunnel --url http://localhost:8787`) —
  instant public https URL with **no account and no domain**, but the URL changes on
  every restart. Good for a one-off external demo, wrong for daily use.
- **Router port forwarding + dynamic DNS** — not recommended: exposes the office IP
  and the login page to the whole internet.

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
| Unreachable remotely only | Tailscale toggle on the device? `tailscale status` on the PC; `tailscale serve status` shows the https proxy |
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
3. ☐ Remote access up (Tailscale serve); app reachable from a phone on mobile data
   (not office Wi-Fi) at the https://…ts.net address.
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
