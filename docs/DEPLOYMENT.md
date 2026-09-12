# Deployment & Operations

> **The shipped product is the central-PC web app** (ADR-027): the office PC runs the
> server and operators work from browsers. That is Part 2 below, and `release.yml` (the
> 1.0.x line) is the pipeline that feeds it.
>
> **Installing for the client? Follow [`INSTALL_CLIENT.md`](INSTALL_CLIENT.md)** — the
> step-by-step field guide. This document is the reference behind it.
>
> **Part 1 (Android) is dormant.** `android-release.yml` is manual-dispatch only and the
> Android runtime stays in the tree unused. It is kept for reference, not for installation.

# Part 1 — The Android app (dormant — not what the client installs)

## What it is

One APK. Inside it, the app carries the whole system: the screens, the business rules and
a SQLite database that lives in the device's own private storage. It works with no
internet at all; the internet is used only to look for updates.

```
[Android tablet / phone]
  Bharti Enterprises.apk
    └── WebView (https://localhost — a fixed origin, never changes)
          ├── UI thread ....... screens + updates/backups (device operations)
          └── Worker .......... the server: SQLite (OPFS), migrations, all business rules
                                  │
                                  └── app.db  ← business data AND photos, one file
                                      (owned by the origin, NOT by the app bundle,
                                       which is why an update cannot touch it)
```

## Installing it the first time

1. On the phone/tablet: **Settings → Apps → Special access → Install unknown apps** and
   allow the browser (or Files) to install apps. This is needed because the app is not
   distributed through the Play Store.
2. Open the latest release at `github.com/iodex99/bharti-releases/releases/latest` and
   download `bharti-v1.1.<N>.apk` — that repo is public, so the device can fetch it
   directly with no GitHub account.
3. Open the downloaded file and confirm the install.
4. Open the app. On first run it creates the admin account and **shows the username and
   password on the sign-in screen** — write them down. You are taken straight to
   "Change password"; the one-time password stops being shown once you have set your own.
5. The setup screen offers **Start fresh** or **Move from another device**.

**Keep the device's Android System WebView up to date** (Play Store → Android System
WebView). The app stores data using OPFS, which needs a reasonably current WebView. If it
is too old the app still runs, on a slower fallback, and says so on screen.

## Updating

Pushing to `main` publishes a release; the installed app checks for one every 30 minutes
and on every start.

- **Normal update (almost always):** a banner appears; the Admin taps **Update now**. The
  app downloads the new bundle, checks its checksum, unpacks it, restarts itself, and is
  running the new version in a few seconds. Nothing is installed by Android; the user
  confirms nothing.
- **App-file update (rare):** only when the native shell itself changed. The banner says
  *Download app file* and Android asks the user to confirm the install, as it does for
  any APK. Data is untouched by this too.

**Data is never part of an update.** The database lives in the WebView origin's private
storage; a bundle swap replaces application code only. The app additionally writes a
safety copy of the database immediately before applying any update, and a bundle that
fails to start twice is rolled back to the previous one automatically.

### Releasing (for the developer)

**Set up the public releases repo first (do this once).** This source repository is
private, so `api.github.com/.../releases/latest` answers **404** to anyone without a
token — an installed app would never see an update, and the APK would not be downloadable
without a GitHub login. Releases therefore go to a small **public** repository instead,
which keeps the source private while letting devices update with no credentials at all:

1. Create a public repo `iodex99/bharti-releases`, **ticking "Add a README"** (it needs a
   default branch before a release can be attached to it).
2. GitHub → Settings → Developer settings → **Fine-grained tokens** → generate one with
   *Repository access: only `bharti-releases`* and *Permissions → Contents: Read and
   write*.
3. Add it to **this** repo as the secret `RELEASES_REPO_TOKEN`.
4. Optional: set the repository variable `RELEASES_REPO` if you name it something else.

Until that secret exists, releases are published here instead and the workflow prints a
warning saying devices will not see them — CI stays green, but updates do not reach the
tablet.

`.github/workflows/android-release.yml` runs on every push to `main`. It gates on
typecheck + lint + the full unit/integration suite + all three E2E projects, then
publishes `v1.1.<run_number>` to the releases repo with:

| Asset | What it is |
|---|---|
| `web-bundle-v1.1.N.zip` | what the installed app downloads and swaps in by itself |
| `bharti-v1.1.N.apk` | full installer — first install, or a native-shell change |
| `app-manifest.json` | version, sha256s and `minNativeVersion` — how the app decides |
| `checksums.txt` | sha256sums, for verifying by hand |

**Signing (do this once).** Android only upgrades an app in place when the new APK is
signed with the *same* key.

```bash
node scripts/make-keystore.mjs
```

This writes, into `bharti-signing/` **beside** the repository (never inside it):

| File | What |
|---|---|
| `bharti-release.keystore` | the signing key itself — PKCS12, RSA 2048, 30-year validity |
| `keystore.b64` | the same file base64-encoded, one line, for the secret |
| `SECRETS.txt` | the four values to paste, and the generated password |

Add them as repository secrets at *Settings → Secrets and variables → Actions*:
`ANDROID_KEYSTORE_BASE64` (all of `keystore.b64`), `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS` (`bharti`), `ANDROID_KEY_PASSWORD` (same as the store password —
PKCS12 uses one password for both).

**Back that folder up and keep it.** If the key is lost, no future release can update an
app already installed on a device: the only way forward is uninstall + reinstall, which
**erases that device's data**. The script refuses to overwrite an existing keystore for
the same reason.

Until the secrets exist CI still produces an APK, but debug-signed — and it is published
as `bharti-v<version>-UNSIGNED-do-not-install.apk`, because installing one and then
switching to properly signed releases would force exactly that data-erasing reinstall.

**When the native shell changes** (a new Capacitor plugin, a new permission, a Capacitor
upgrade), put the *current* release run number into `android/native-version.txt`. That is
how the app knows a web bundle alone is no longer enough and asks for the APK instead.

## Backups and moving to a new device

- A **daily backup** is taken automatically inside the app's private storage, and on every
  start-up if the day's backup is missing.
- **Backups → Download complete backup** writes the whole business (database *and* photos
  — they are in the same file) into the device's Documents folder and opens Android's
  share sheet, so it can be sent to **Google Drive**, WhatsApp, email or a cable in one
  tap. Do this weekly, and always before moving devices.
- **Moving to a new device:** install the app on the new device, open it, choose
  **Move from another device** on the setup screen, and pick the backup file (from Drive
  or the Files app). It replaces everything and asks everyone to sign in again.

Restoring refuses any file that is not one of the app's own backups.

## If the app will not start

Business data is stored separately from the app bundle, so it survives every one of these:

1. Force-stop the app and reopen it — a bundle that fails twice rolls back on its own.
2. If it still fails, reinstall the APK. The data on the device stays where it is.
3. Restore the most recent complete backup only if the data itself is in doubt.

---

# Part 2 — The PC/server deployment (the shipped product)

Everything below describes the Windows-server topology the client actually runs: the
supervisor, releases from `release.yml`, Tailscale remote access and the operational
runbook. For the install itself, work through [`INSTALL_CLIENT.md`](INSTALL_CLIENT.md);
this part is the reference it draws on.

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

- Automatic: daily 13:00 IST (`data\backups\daily-*.db`, keep 30, with catch-up if the PC
  was off) + a pre-update copy before every version change + a `pre-restore-*` copy before
  any in-app restore.
- Manual: Administration → Backups → *Backup now* / *Download*. **Take a copy off the
  office PC weekly** (pen drive or cloud drive) — or configure the Google Drive folder so
  it happens automatically.
- **Complete backup vs daily backup:** the daily `.db` files hold the database only. A
  **complete backup** (Backups → *Download complete backup*) is a single `.zip` holding the
  database **and every uploaded photo** — this is the file you use to move to a new PC.
- **Restore drill (manual, DB only):** stop the service (`Stop-Service bharti-app`),
  replace `C:\bharti\data\app.db` with the chosen backup file (delete `app.db-wal`/
  `app.db-shm` if present), start the service, verify System Health shows all checks ✅.
- **Restore drill (in-app, complete):** Administration → Backups → *Restore* → choose a
  complete-backup file (or a Google Drive one) → type RESTORE. The app copies the current
  data aside (`backups\pre-restore-*`), swaps in the backup, re-checks integrity, and
  **rolls back automatically** if anything fails. Everyone is signed out; sign in with an
  account from the restored data.

## Migrating to a new computer

The whole business is portable. On the **new PC**:

1. Install the app exactly like a first go-live (Node 24 + `install-service.ps1`, above).
2. Open the app and sign in as admin. Because there is no data yet, the **first-run setup
   wizard** appears — choose **"Move from another computer"**.
3. Provide the complete backup, either way:
   - **File:** on the OLD PC, Backups → *Download complete backup*; copy that `.zip` to the
     new PC (pen drive / email / Drive) and pick it in the wizard; **or**
   - **Google Drive:** on the OLD PC, Backups → *Send a complete backup to Google Drive*;
     install Drive for Desktop on the new PC signed into the same account, and the wizard's
     restore card lists it — pick the latest.
4. Type RESTORE. The app restores the database **and all photos**, then signs you out.
   Sign in with the usual accounts (they came across in the backup) and verify System
   Health is all ✅.

The old PC is untouched — keep it until the new one is verified. Nothing about the account
passwords, masters, ledger, audit trail or photos is lost.

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
4. ☐ **Offices configured** (Admin → Offices) if there is more than one; each office's
   code chosen (it prefixes that office's document numbers).
5. ☐ Users created (operators pinned to their office, + owner) with temporary passwords;
   each signed in once.
6. ☐ Masters entered: colors, sizes, vendors, contractors, staff. (No models — the code
   number is typed at cutting.)
7. ☐ **Opening balances** entered from the registers (Admin → Opening Balances) for all
   stages that hold stock, per office (RAW takes yards + width; stitched stages a typed
   code); Inventory page matches the physical count in each office.
8. ☐ System Health: every self-check ✅.
9. ☐ Backup taken (Backups → Backup now) and a copy stored off the PC.
10. ☐ Update drill on the real install: push a trivial change → banner appears →
    *Update now* → new version live, data intact.
11. ☐ Restore drill rehearsed once (stop service, swap DB from backup, start, verify).
12. ☐ Complete backup downloaded once and kept off-site (this is the migration file).
13. ☐ Staff walked through docs/USER_GUIDE.md on their own phones.
