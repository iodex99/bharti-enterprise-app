# Client Installation Guide

> **Who this is for:** the person physically setting the system up at Bharti Enterprises —
> you, or a local IT helper. It assumes you are comfortable with Windows and can copy and
> paste a PowerShell command. It assumes **no** knowledge of this codebase.
>
> **Time needed:** about 1 hour for the machine setup (Parts 1–4), then 1–3 hours with the
> owner to enter masters and opening balances (Part 5). Budget half a day in total.
>
> Related: [`DEPLOYMENT.md`](DEPLOYMENT.md) (reference/architecture), [`USER_GUIDE.md`](USER_GUIDE.md)
> (what to hand the staff).

---

## 0. What you are installing

One **office PC** runs the whole system. Everyone else — owner, operators, checkers — just
opens it in a browser on their phone or laptop. There is no cloud server, no monthly bill,
and the business data never leaves that PC except as backups you take deliberately.

```
   [ owner's phone ]   [ operator's phone ]   [ laptop ]
            \                  |                 /
             \_________________|________________/
                               |  https, over Tailscale (private network)
                               |
                    +----------------------+
                    |  OFFICE PC (Windows) |
                    |                      |
                    |  Windows service     |  <- starts on boot, restarts on crash
                    |    +- supervisor     |  <- swaps versions, rolls back failures
                    |        +- the app    |  <- Node + SQLite, port 8787
                    |                      |
                    |  C:\bharti\data\     |  <- app.db, photos, backups
                    |     THE BUSINESS.    |     never touched by an update
                    +----------------------+
```

**The one thing to internalise:** `C:\bharti\data\` **is** the business. Everything else —
the app, the supervisor, Node itself — can be deleted and reinstalled in twenty minutes.
That folder cannot. Every instruction below about backups exists for this reason.

---

## 1. Before you go to the office

Do these at your desk. Walking into the office missing one of these will cost you the visit.

### 1.1 Decide which install path you are using

| | **Path A — online** | **Path B — offline** |
|---|---|---|
| **Use when** | The GitHub repo + CI are live and have published at least one Release | No GitHub access, or you want zero dependency on it during the visit |
| **Office PC needs internet** | Yes, during install and for updates | Only to download Node once |
| **Future updates** | One click, inside the app | You repeat Path B by hand |
| **You carry** | A GitHub token | A USB stick with the built zip |

If you are not certain a GitHub Release already exists, **use Path B**. You can switch the
office to Path A later at any time — it is only a config file change.

### 1.2 Things to have in hand

- [ ] **The office PC's specs confirmed**: Windows 10 or 11, 64-bit, 8 GB RAM, ~20 GB free.
      Any ordinary desktop is plenty. It does **not** need to be powerful.
- [ ] **Administrator access** to that PC (you will install a Windows service).
- [ ] **The office Wi-Fi password**, and whoever can log into the **router**, in case you
      want LAN access (§4.3).
- [ ] **A USB stick**, 1 GB or more. Required for Path B; useful for backups either way.
- [ ] **One business Google account** that will own the Tailscale network and receive
      backups. Agree with the owner *now* whose account this is — changing it later is
      painful. Do not use a staff member's personal account; staff leave.
- [ ] **Path A only — a GitHub token.** GitHub → Settings → Developer settings →
      Fine-grained tokens → Generate. Repository access: **only** the app repo.
      Permissions → **Contents: Read-only**. Copy the `github_pat_...` string somewhere safe;
      GitHub shows it exactly once. **Set the longest expiry allowed** and put a reminder in
      your calendar a week before it lapses — when this token expires, update notifications
      stop silently (see §8).

### 1.3 Path B only — build the zip before you leave

> **Critical:** the release zip contains compiled native modules (`better-sqlite3`,
> `sharp`). They are built against **one specific Node major version and one OS**. Build on
> **Windows x64 with Node 24**, and install Node 24 on the office PC. If you build on
> Node 22, the office PC must then run Node 22 — a mismatch fails at startup with a
> confusing `NODE_MODULE_VERSION` error. Keep the two the same and you never think about
> this again.

On your machine:

```powershell
# 1. Confirm you are on Node 24 — if not, install it from nodejs.org first
node --version          # must print v24.x.x

# 2. From the project folder
npm ci
npm test                # never ship a build whose tests fail
npm run build
node scripts/package-release.mjs 1.0.0
```

This produces `dist-release\bharti-app-v1.0.0.zip` (~100 MB) and `checksums.txt`.

Copy onto the USB stick:

- [ ] `dist-release\bharti-app-v1.0.0.zip`
- [ ] `supervisor\supervisor.cjs`
- [ ] `scripts\winsw\bharti-service.xml`
- [ ] The **Node 24 Windows installer** (`.msi` from nodejs.org) — in case office internet
      is slow or down
- [ ] `WinSW-x64.exe` from `github.com/winsw/winsw/releases/latest`

---

## 2. Prepare the office PC

Sit at the PC and sign in as an administrator.

### 2.1 Stop it going to sleep — do this first

This PC is now a server. If it sleeps, everyone's app stops working and nobody will know
why. This is the single most common cause of "the system is down" calls.

**Settings → System → Power & battery → Screen and sleep**

- Screen off: whatever you like (15 minutes is fine — the screen is not the computer)
- **Sleep: Never**

Then, because Windows keeps a second set of sleep settings that can override the first:

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /hibernate off
```

Also turn **fast startup** off if you see it (Settings → System → Power → Advanced), and if
the BIOS offers **"AC Power Recovery"** or similar, set it to power on after a cut. After a
power failure you want this machine to come back by itself.

### 2.2 Install Node 24

Download the **LTS 24.x Windows Installer (.msi)** from https://nodejs.org and run it with
default options. Then **open a new PowerShell window** and confirm:

```powershell
node --version          # must print v24.x.x
```

If it prints a different major version the app will not start. Uninstall the other Node from
Add/Remove Programs and install 24.

### 2.3 Set the clock

**Settings → Time & language → Date & time** → time zone **(UTC+05:30) Chennai, Kolkata,
Mumbai, New Delhi**, with "Set time automatically" **on**.

Business dates and the backup schedule are pinned to IST in code, so this is not strictly
required — but a wrong clock makes log timestamps and audit entries confusing to read, and
you will regret it during a support call.

---

## 3. Install the app

### Path A — online install (GitHub Releases)

Copy the project's `scripts\` and `supervisor\` folders onto the PC (USB stick, or a repo
checkout — the script looks for `supervisor.cjs` beside itself or one level up).

Open PowerShell **as Administrator**, change into that `scripts` folder, then:

```powershell
powershell -ExecutionPolicy Bypass -File install-service.ps1 `
  -Root C:\bharti -Port 8787 -GithubToken "github_pat_XXXXXXXX"
```

The script creates `C:\bharti\{supervisor,releases,data,logs,service}`, writes the supervisor
config, downloads the latest Release zip and extracts it, downloads WinSW, then installs and
starts the **bharti-app** service. It prints the installed version when it finishes.

Skip to §3.3.

### Path B — offline install (from the USB stick)

Run these in PowerShell **as Administrator**. They do by hand exactly what Path A automates.

```powershell
# --- 1. folder scaffold ---
New-Item -ItemType Directory -Force C:\bharti\supervisor,
                                    C:\bharti\releases,
                                    C:\bharti\data,
                                    C:\bharti\logs,
                                    C:\bharti\service | Out-Null

# --- 2. supervisor + its config (change E: to your USB drive letter) ---
Copy-Item E:\supervisor.cjs C:\bharti\supervisor\supervisor.cjs -Force

@{ port = 8787 } | ConvertTo-Json |
  Set-Content -Encoding utf8 C:\bharti\supervisor\config.json

# --- 3. unpack the release and mark it current ---
New-Item -ItemType Directory -Force C:\bharti\releases\v1.0.0 | Out-Null
tar -xf E:\bharti-app-v1.0.0.zip -C C:\bharti\releases\v1.0.0
Set-Content -Encoding ascii C:\bharti\current.txt "v1.0.0"

# --- 4. install the Windows service ---
Copy-Item E:\WinSW-x64.exe      C:\bharti\service\bharti-service.exe -Force
Copy-Item E:\bharti-service.xml C:\bharti\service\bharti-service.xml -Force

C:\bharti\service\bharti-service.exe install C:\bharti\service\bharti-service.xml
C:\bharti\service\bharti-service.exe start   C:\bharti\service\bharti-service.xml
```

Notes:

- The folder name under `releases\` and the contents of `current.txt` **must match exactly**,
  including the leading `v`. This is the most common mistake in a manual install.
- This config omits `repo` and `githubToken`, so the app simply never offers updates. That is
  correct for Path B. To switch to Path A later, add those two keys to
  `C:\bharti\supervisor\config.json` and restart the service.
- If SmartScreen or antivirus blocks `WinSW-x64.exe`: right-click → Properties → **Unblock**,
  or add a `C:\bharti` exclusion.

### 3.3 Confirm it is alive

```powershell
Get-Service bharti-app                       # Status must be Running
Invoke-RestMethod http://localhost:8787/api/system/health
```

Health should answer `ok = True` with a version. Then open **http://localhost:8787** in the
PC's own browser — you should get the sign-in screen.

**If not**, read `C:\bharti\logs\supervisor.log` and `C:\bharti\logs\app.log`. Those two
files say what went wrong in plain language; §8 lists the usual causes.

---

## 4. First sign-in, then remote access

### 4.1 The initial admin password

On its very first boot the app creates the admin account and writes the password to:

```
C:\bharti\data\initial-admin-password.txt
```

Open it and sign in as `admin` with that password. The app **forces** a password change
immediately. Set the owner's real password with them sitting there — do not choose one
yourself and plan to tell them later.

Then **delete `initial-admin-password.txt`**. It is now dead weight and a live credential
sitting in a folder.

### 4.2 The setup wizard

With an empty database the app offers two choices:

- **Start fresh** — a brand new business. This is what you want for a first install.
- **Move from another computer** — restores a complete backup from an old PC. Use this only
  when replacing a machine (§7).

### 4.3 Remote access with Tailscale

Staff need the app from their own phones, including on mobile data. Tailscale is the right
answer here: free, needs **no domain name**, and the app is never exposed to the public
internet at all. Only devices signed into your private network can reach it.

**On the office PC** (elevated PowerShell):

```powershell
winget install Tailscale.Tailscale
tailscale up                                  # opens a browser — sign in with the ONE
                                              # business account agreed in §1.2
tailscale serve --bg localhost:8787
tailscale dns status                          # note the name, e.g. office-pc.tail1a2b3c.ts.net
```

Write that `...ts.net` address down — it is the address the whole business will use.

If HTTPS is not yet on, the Tailscale admin console (**DNS** tab) has a one-time
**MagicDNS + HTTPS certificates** switch. Turn it on; `tailscale serve` needs it to issue a
real certificate. The certificate matters: without HTTPS, secure cookies and "Add to Home
Screen" both misbehave.

**On each staff phone:** install Tailscale (Play Store / App Store) → sign in with the
**same business account** → turn the VPN toggle on → open `https://office-pc....ts.net` in
Chrome or Safari → menu → **Add to Home Screen**. It now behaves like an installed app.

Test this properly: turn Wi-Fi **off** on a phone and load the app over mobile data. If that
works, remote access is genuinely done.

**Optional — plain LAN access for PCs in the office.** If office desktops on the same Wi-Fi
should reach the app without Tailscale, open the port once:

```powershell
New-NetFirewallRule -DisplayName "Bharti app" -Direction Inbound `
  -LocalPort 8787 -Protocol TCP -Action Allow -Profile Private
ipconfig | Select-String IPv4        # note the office PC's LAN address
```

They then use `http://192.168.x.x:8787`. This is plain HTTP on the local network only — fine
inside the office, and it breaks if the router hands the PC a different IP. If you rely on
it, reserve a static IP for the PC in the router's DHCP settings.

---

## 5. Set the business up (do this with the owner)

The machine is ready; the business is not. Sit with the owner for this part — most of it is
their information, not yours. Order matters: each step depends on the one above it.

1. **Offices** (Admin → Offices) — only if there is more than one location. Each office gets
   a short code that prefixes its document numbers (`BR-RM-0001`); the original office keeps
   plain numbers. Decide the codes now, because they appear on every document forever.

2. **Users** (Admin → Users) — one account per person, each with a temporary password. Give
   operators the **office they work at** (they are pinned to it); admin and owner can switch
   offices from the top bar. Have every person sign in once **while you are still there** and
   set their own password. Accounts nobody has ever signed into are the number one support
   call in week one.

3. **Masters** — colours, sizes, vendors, contractors, staff. Note:
   - There is **no models master**. The code number is typed at cutting, and the photo follows
     that code everywhere automatically.
   - Checkers and packers carry a **per-dozen rate** — their pay is calculated from it, so get
     it right at entry.
   - Contractors and staff can carry a **payment QR photo**, shown when paying them. Worth
     collecting on day one; it saves hunting for QR codes later.

4. **Opening balances** (Admin → Opening Balances) — the current physical stock, copied from
   the paper registers, per office and per stage. **This is the highest-stakes step of the
   whole installation.** Every report, every traceability chain and every reconciliation check
   is measured from these numbers.
   - RAW cloth takes **yards and width**.
   - Stitched stages take a typed code.
   - Do it on a day when production is stopped or quiet, ideally straight after a physical
     count. A number typed wrong here looks like a real discrepancy for months afterwards.

5. **Check your work**: Inventory should now match what is physically in the room, in every
   office. Then open **Admin → System Health** — every self-check must be ✅ before you go any
   further.

---

## 6. Backups — set this up before go-live, not after

The app already protects itself:

- **Daily automatic backup at 13:00 IST** into `C:\bharti\data\backups\`, keeping 30 days. If
  the PC was off at 13:00 it catches up on the next start.
- **A copy before every update**, and before every in-app restore.

All of that lives on the same PC — which is worth nothing if that PC is stolen, its disk
dies, or the office floods. **You must arrange one copy that leaves the building.**

**Do this now, with the owner:**

1. Administration → Backups → **Download complete backup**. This is a single `.zip` holding
   the database **and every photo** — the file you would rebuild the business from.
2. Put it somewhere off the PC: Google Drive on the business account, or the USB stick you
   then take away with you.
3. Agree **who does this and how often** — weekly is right for this business — and write that
   person's name into the handover notes. A backup routine with nobody's name against it does
   not happen.

Best option if they will accept it: install **Google Drive for Desktop** on the office PC,
signed into the business account, and save complete backups into the synced folder. Then the
off-site copy happens whether or not anyone remembers.

---

## 7. Replacing the office PC later

The whole business is portable, and this is worth rehearsing once while the old PC still
works.

1. On the **new** PC, do Parts 2 and 3 exactly as for a first install.
2. On the **old** PC: Backups → **Download complete backup**.
3. On the **new** PC, sign in as admin. The database is empty, so the setup wizard appears —
   choose **Move from another computer**, give it that zip, and type `RESTORE`.
4. Everything comes across: accounts, masters, the full ledger, the audit trail and all
   photos. Everyone signs in with their existing passwords.
5. Verify **System Health** is all ✅ and that Inventory matches the old PC.

**Keep the old PC untouched until the new one is verified.** Then move Tailscale across
(`tailscale up` on the new PC with the same account, then
`tailscale serve --bg localhost:8787`) and tell staff the new address, or reuse the old
machine name.

---

## 8. When something goes wrong

Two log files answer almost everything: `C:\bharti\logs\supervisor.log` (versions, updates,
restarts) and `C:\bharti\logs\app.log` (the app itself).

| Symptom | Cause and fix |
|---|---|
| Nothing loads, on any device | `Get-Service bharti-app`. Not Running → `Start-Service bharti-app`, then read `supervisor.log`. |
| Works in the office, not outside | Tailscale VPN toggle off on that phone, or Tailscale not running on the PC. Check `tailscale status`, then `tailscale serve status`. |
| Worked yesterday, dead this morning | The PC slept or was switched off. Re-do §2.1 — a sleep setting almost certainly survived. |
| `NODE_MODULE_VERSION` error in `app.log` | Node major version ≠ the one the zip was built with. Install the matching Node (§1.3). |
| Service installs but exits instantly | `current.txt` does not match the folder name under `releases\` (check the leading `v`), or the zip was extracted one level too deep — `releases\v1.0.0\server\dist\index.js` must exist. |
| Update banner never appears (Path A) | The GitHub token expired. Put a new one into `C:\bharti\supervisor\config.json` → `githubToken`, then `Restart-Service bharti-app`. |
| An update failed | Nothing to do — it rolled back to the previous version *and* its database automatically. Check `C:\bharti\update-status.json`, then tell the developer. |
| System Health shows ❌ | **Stop entering data.** Take a manual backup immediately, then contact the developer. The ledger self-checks have found an inconsistency. |
| Disk filling up | Safe to delete: `C:\bharti\tmp`, release folders beyond the newest 3, old files in `data\backups`. **Never** touch `data\app.db`. |

**Manual update, if GitHub is unreachable:** download the Release zip on any machine, copy it
across, extract into `C:\bharti\releases\v1.0.N\`, write that version string into
`C:\bharti\current.txt`, then `Restart-Service bharti-app`.

---

## 9. Go-live checklist

The installation is not finished until every line is ticked.

**The machine**

1. ☐ Sleep and hibernate disabled; PC returns on its own after a power cut
2. ☐ Node 24 installed; `node --version` confirms it
3. ☐ `bharti-app` service Running, and **survives a reboot** — restart the PC and re-check.
   Do not skip this; it is the entire point of installing it as a service.
4. ☐ `http://localhost:8787` answers on the PC itself

**Access**

5. ☐ Initial admin password changed; `initial-admin-password.txt` deleted
6. ☐ Tailscale serving HTTPS; app reachable from a phone **on mobile data, not office Wi-Fi**
7. ☐ Every staff phone has Tailscale installed and the app on its home screen

**The business data**

8. ☐ Offices configured (if more than one), codes agreed
9. ☐ Users created, each pinned to the right office, **each signed in once in front of you**
10. ☐ Masters entered: colours, sizes, vendors, contractors, staff — with per-dozen rates and
    payment QRs
11. ☐ Opening balances entered per office; **Inventory matches the physical count**
12. ☐ Admin → System Health: every check ✅

**Safety net**

13. ☐ Complete backup downloaded and stored **off the PC**
14. ☐ Backup routine agreed, with a named person responsible
15. ☐ Restore rehearsed once, or at minimum walked through with the owner
16. ☐ Path A only: update drill done — a release appears, Admin clicks *Update now*, the new
    version runs, the data is intact

**People**

17. ☐ Owner walked through the dashboard, the reports and the Backups screen
18. ☐ Staff walked through [`USER_GUIDE.md`](USER_GUIDE.md) on their own phones
19. ☐ Everyone knows who to call, and knows that the answer to "something looks wrong" is
    **stop and call**, not "carry on and sort it out later"

---

## 10. Leave this with the owner

One page, taped near the office PC:

- The app address: `https://office-pc....ts.net`
- **Never switch this PC off, and never let it sleep**
- Who takes the weekly backup, and where it goes
- Your phone number
- "If the app says a self-check failed: stop entering data and call."
