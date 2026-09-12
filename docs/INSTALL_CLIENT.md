# Client Installation Guide

> **Who this is for:** the person physically setting the system up at Bharti Enterprises —
> you, or a local IT helper. It assumes you are comfortable with Windows and can copy and
> paste a PowerShell command. It assumes **no** knowledge of this codebase.
>
> **Time needed:** about 30 minutes for the machine setup (Parts 1–4), then 1–3 hours with
> the owner to enter masters and opening balances (Part 5).
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
                    +------------------------+
                    |  OFFICE PC (Windows)   |
                    |                        |
                    |  Windows service       |  <- starts on boot, restarts on crash
                    |    +- supervisor       |  <- swaps versions, rolls back failures
                    |        +- the app      |  <- its own Node + SQLite, port 8787
                    |                        |
                    |  C:\bharti\data\       |  <- app.db, photos, backups
                    |     THE BUSINESS       |     never touched by an update
                    +------------------------+
```

**The one thing to internalise:** `C:\bharti\data\` **is** the business. Everything else —
the app, the supervisor, the Node runtime — can be deleted and reinstalled in twenty
minutes. That folder cannot. Every instruction below about backups exists for this reason.

**Nothing needs to be installed first.** The release carries its own Node runtime, and
releases are public, so there is no software prerequisite and no access token to create.

---

## 1. Before you go to the office

### 1.1 Which install path

| | **Path A — online** | **Path B — offline** |
|---|---|---|
| **Use when** | The office PC has internet | No internet at the office |
| **What you carry** | Nothing | A USB stick with 3 files |
| **Command** | One line | One line |

Both are a single command now. Path A is the normal one.

### 1.2 Things to have in hand

- [ ] **The office PC's specs confirmed**: Windows 10 or 11, 64-bit, 8 GB RAM, ~20 GB free.
      Any ordinary desktop is plenty. It does **not** need to be powerful.
- [ ] **Administrator access** to that PC (you will install a Windows service).
- [ ] **The office Wi-Fi password**, and whoever can log into the router, in case you want
      LAN access (§4.3).
- [ ] **One business Google account** that will own the Tailscale network and receive
      backups. Agree with the owner *now* whose account this is — changing it later is
      painful. Never a staff member's personal account; staff leave.
- [ ] The project's `scripts\` and `supervisor\` folders, on a USB stick or as a checkout.

> **No GitHub token.** Releases are published to a public feed (ADR-042), so the office PC
> needs no credentials to install or to update. Nothing to create, nothing to renew.

### 1.3 Path B only — prepare the USB stick

On your own machine, build the release:

```powershell
npm ci
npm test
npm run build
node scripts/package-release.mjs 1.0.0
```

That writes `dist-release\bharti-app-v1.0.0.zip` (~70 MB, Node runtime included).

Copy onto the stick:

- [ ] `dist-release\bharti-app-v1.0.0.zip`
- [ ] `WinSW-x64.exe` from `github.com/winsw/winsw/releases/latest`
- [ ] The project's `scripts\` and `supervisor\` folders

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

### 2.2 Set the clock

**Settings → Time & language → Date & time** → time zone **(UTC+05:30) Chennai, Kolkata,
Mumbai, New Delhi**, with "Set time automatically" **on**.

Business dates and the backup schedule are pinned to IST in code, so this is not strictly
required — but a wrong clock makes log timestamps and audit entries confusing to read, and
you will regret it during a support call.

> There is **no step here for installing Node**. The release brings its own (ADR-044).

---

## 3. Install the app — one command

Open PowerShell **as Administrator** and change into the project's `scripts` folder.

**Path A — online:**

```powershell
powershell -ExecutionPolicy Bypass -File install-service.ps1
```

**Path B — offline** (change `E:` to your USB drive letter):

```powershell
powershell -ExecutionPolicy Bypass -File install-service.ps1 `
  -ZipPath E:\bharti-app-v1.0.0.zip -WinswPath E:\WinSW-x64.exe
```

The installer creates `C:\bharti\{supervisor,releases,data,logs,service,node}`, fetches or
unpacks the release, reads the version **out of the release itself** (so the version folder
and `current.txt` can never disagree), copies the bundled Node runtime to the root,
installs and starts the **bharti-app** service, then waits until the app actually answers
and prints the first-time admin password.

Re-running it is safe — it installs the newest release over the top and restarts the
service. `C:\bharti\data` is never touched.

If it finishes with anything other than a green "Installed and running", read
`C:\bharti\logs\supervisor.log` and `C:\bharti\logs\app.log`; §8 lists the usual causes.

---

## 4. First sign-in, then remote access

### 4.1 The initial admin password

The installer prints it, and it is also written to:

```
C:\bharti\data\initial-admin-password.txt
```

Sign in as `admin` with that password. The app **forces** a password change immediately.
Set the owner's real password with them sitting there — do not choose one yourself and plan
to tell them later.

Then **delete `initial-admin-password.txt`**. It is now dead weight and a live credential
sitting in a folder.

### 4.2 The setup wizard

With an empty database the app offers two choices:

- **Start fresh** — a brand new business. This is what you want for a first install.
- **Move from another computer** — restores a complete backup from an old PC. Use this only
  when replacing a machine (§7).

### 4.3 Remote access with Tailscale

Staff need the app from their own phones, including on mobile data. Tailscale fits here:
free, needs **no domain name**, and the app is never exposed to the public internet at all.
Only devices signed into your private network can reach it.

```powershell
winget install Tailscale.Tailscale
tailscale up                     # sign in with the ONE business account (§1.2)
tailscale serve --bg localhost:8787
tailscale dns status             # note e.g. office-pc.tail1a2b3c.ts.net
```

Write that `…ts.net` address down — it is the address the whole business will use.

If HTTPS is not yet on, the Tailscale admin console (**DNS** tab) has a one-time
**MagicDNS + HTTPS certificates** switch. Turn it on; `tailscale serve` needs it to issue a
real certificate. That certificate matters — without HTTPS, secure cookies and "Add to Home
Screen" both misbehave.

**On each staff phone:** install Tailscale → sign in with the **same business account** →
turn the VPN toggle on → open `https://office-pc.….ts.net` → menu → **Add to Home Screen**.

Test it properly: turn Wi-Fi **off** on a phone and load the app over mobile data. If that
works, remote access is genuinely done.

**Optional — plain LAN access for office desktops:**

```powershell
New-NetFirewallRule -DisplayName "Bharti app" -Direction Inbound `
  -LocalPort 8787 -Protocol TCP -Action Allow -Profile Private
ipconfig | Select-String IPv4     # note the PC's LAN address
```

They then use `http://192.168.x.x:8787`. Plain HTTP on the local network only — fine inside
the office, and it breaks if the router hands the PC a different IP. If you rely on it,
reserve a static IP for the PC in the router's DHCP settings.

---

## 5. Set the business up (with the owner)

The machine is ready; the business is not. Sit with the owner — most of this is their
information, not yours. Order matters: each step depends on the one above it.

1. **Offices** (Admin → Offices) — only if there is more than one location. Each office gets
   a short code that prefixes its document numbers (`BR-RM-0001`); the original office keeps
   plain numbers. Decide the codes now — they appear on every document forever.

2. **Users** (Admin → Users) — one account per person, each with a temporary password. Give
   operators the **office they work at** (they are pinned to it); admin and owner switch
   offices from the top bar. Have every person sign in once **while you are still there** and
   set their own password. Accounts nobody has ever signed into are the number one support
   call in week one.

3. **Masters** — colours, sizes, vendors, contractors, staff:
   - There is **no models master**. The code number is typed at cutting, and the photo
     follows that code everywhere automatically.
   - Checkers and packers carry a **per-dozen rate** — their pay is calculated from it.
   - Contractors and staff can carry a **payment QR photo**, shown when paying them. Worth
     collecting on day one.

4. **Opening balances** (Admin → Opening Balances) — the current physical stock from the
   paper registers, per office and per stage. RAW cloth takes **yards and width**; stitched
   stages take a typed code.

   **This is the highest-stakes step of the whole installation.** Every report, traceability
   chain and reconciliation check is measured from these numbers. Do it on a day when
   production is quiet, ideally straight after a physical count. A number typed wrong here
   looks like a real discrepancy for months.

5. **Check your work**: Inventory should match what is physically in the room, in every
   office. Then **Admin → System Health** — every self-check must be green.

---

## 6. Backups — set this up before go-live

The app protects itself:

- **Daily automatic backup at 13:00 IST** into `C:\bharti\data\backups\`, keeping 30 days.
  If the PC was off at 13:00 it catches up on the next start.
- **A copy before every update**, and before every in-app restore.

All of that lives on the same PC — worth nothing if that PC is stolen, its disk dies, or the
office floods. **You must arrange one copy that leaves the building.**

1. Administration → Backups → **Download complete backup** — one `.zip` with the database
   **and every photo**, the file you would rebuild the business from.
2. Put it somewhere off the PC: Google Drive on the business account, or the USB stick.
3. Agree **who does this and how often** — weekly — and write that person's name into the
   handover notes. A backup routine with nobody's name against it does not happen.

Best option if they will accept it: install **Google Drive for Desktop** on the office PC,
signed into the business account, and save complete backups into the synced folder. Then the
off-site copy happens whether or not anyone remembers.

---

## 7. Updates happen by themselves

Once installed, the office PC keeps itself current. Nobody has to do anything.

```
  developer pushes  ->  CI builds + runs every test  ->  public release
                                                             |
                        office PC notices within a minute  <--+
                                                             |
                        waits until nobody has worked for 3 minutes
                                                             |
                        backs up the DB, swaps version, health-checks
                                                             |
                        open browsers reload themselves on the new version
```

- **Typical delay from your push to the office running it: 6–10 minutes**, almost all of it
  CI building and testing.
- It **waits for a quiet moment** so nobody loses a half-typed form. Screens that refresh on
  a timer — the dashboard, stock, the update check — deliberately do not count as somebody
  working, so a browser left open on a desk cannot hold updates off forever.
- If anything goes wrong the supervisor **rolls back automatically**, database included.
- An admin can still press **Update now** to apply one immediately.
- **Admin → System Health** has the controls: turn automatic updates off, or change the
  quiet period from 3 minutes.

Nothing about an update touches `C:\bharti\data`.

---

## 8. Replacing the office PC later

1. On the **new** PC, do Parts 2 and 3 exactly as for a first install.
2. On the **old** PC: Backups → **Download complete backup**.
3. On the new PC, sign in as admin. The database is empty, so the setup wizard appears —
   choose **Move from another computer**, give it that zip, and type `RESTORE`.
4. Everything comes across: accounts, masters, the full ledger, the audit trail and all
   photos. Everyone signs in with their existing passwords.
5. Verify **System Health** is all green and Inventory matches the old PC.

**Keep the old PC untouched until the new one is verified.** Then move Tailscale across
(`tailscale up` with the same account, then `tailscale serve --bg localhost:8787`).

---

## 9. When something goes wrong

Two log files answer almost everything: `C:\bharti\logs\supervisor.log` (versions, updates,
restarts) and `C:\bharti\logs\app.log` (the app itself).

| Symptom | Cause and fix |
|---|---|
| Nothing loads, on any device | `Get-Service bharti-app`. Not Running → `Start-Service bharti-app`, then read `supervisor.log`. |
| Works in the office, not outside | Tailscale toggle off on that phone, or Tailscale not running on the PC. `tailscale status`, then `tailscale serve status`. |
| Worked yesterday, dead this morning | The PC slept or was switched off. Re-do §2.1 — a sleep setting almost certainly survived. |
| Updates never arrive | Check the release actually published (GitHub Actions green, and it appears in the `bharti-releases` repo). Then System Health → is auto-update off? Then `supervisor.log`. |
| Update keeps waiting | Somebody is working, or a screen that counts as work is open. It will apply at the first genuine 3-minute gap; an admin can press Update now. |
| An update failed | Nothing to do — it rolled back to the previous version *and* its database automatically. Check `C:\bharti\update-status.json`, then tell the developer. |
| System Health shows a failure | **Stop entering data.** Take a manual backup immediately, then contact the developer. |
| Disk filling up | Safe to delete: `C:\bharti\tmp`, release folders beyond the newest 3, old files in `data\backups`. **Never** touch `data\app.db`. |

**Manual update, if the feed is unreachable:** re-run the installer with
`-ZipPath <the new zip>`. It installs that release over the top and restarts the service.

---

## 10. Go-live checklist

**The machine**

1. ☐ Sleep and hibernate disabled; PC returns on its own after a power cut
2. ☐ `bharti-app` service Running, and **survives a reboot** — restart the PC and re-check.
   Do not skip this; it is the entire point of installing it as a service.
3. ☐ `http://localhost:8787` answers on the PC itself

**Access**

4. ☐ Initial admin password changed; `initial-admin-password.txt` deleted
5. ☐ Tailscale serving HTTPS; app reachable from a phone **on mobile data, not office Wi-Fi**
6. ☐ Every staff phone has Tailscale installed and the app on its home screen

**The business data**

7. ☐ Offices configured (if more than one), codes agreed
8. ☐ Users created, each pinned to the right office, **each signed in once in front of you**
9. ☐ Masters entered: colours, sizes, vendors, contractors, staff — with per-dozen rates and
   payment QRs
10. ☐ Opening balances entered per office; **Inventory matches the physical count**
11. ☐ Admin → System Health: every check green

**Safety net**

12. ☐ Complete backup downloaded and stored **off the PC**
13. ☐ Backup routine agreed, with a named person responsible
14. ☐ Restore rehearsed once, or at minimum walked through with the owner
15. ☐ Update drill watched once end to end: push a trivial change, confirm the office PC
    picks it up and applies it by itself, and that data is intact afterwards

**People**

16. ☐ Owner walked through the dashboard, the reports and the Backups screen
17. ☐ Staff walked through [`USER_GUIDE.md`](USER_GUIDE.md) on their own phones
18. ☐ Everyone knows who to call, and knows that the answer to "something looks wrong" is
    **stop and call**, not "carry on and sort it out later"

---

## 11. Leave this with the owner

One page, taped near the office PC:

- The app address: `https://office-pc.….ts.net`
- **Never switch this PC off, and never let it sleep**
- The app updates itself — there is nothing to install, ever
- Who takes the weekly backup, and where it goes
- Your phone number
- "If the app says a self-check failed: stop entering data and call."
