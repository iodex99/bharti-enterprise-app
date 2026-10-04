# Client Installation Guide

> **Who this is for:** the person setting the system up at Bharti Enterprises — you, or a
> local IT helper. You need to be able to open PowerShell and paste one line. No knowledge
> of this codebase is assumed.
>
> **Time needed:** about 20 minutes at the PC (Parts 2–5), then 1–3 hours with the owner
> entering masters and opening balances (Part 6).
>
> Related: [`DEPLOYMENT.md`](DEPLOYMENT.md) (how it all works), [`USER_GUIDE.md`](USER_GUIDE.md)
> (what to hand the staff).

---

## The short version

On the office PC, open **PowerShell** and paste:

```powershell
irm https://github.com/iodex99/bharti-releases/releases/latest/download/install.ps1 | iex
```

Click **Yes** when Windows asks for permission. Wait for the green **INSTALLED AND RUNNING**.
Write down the username and password it shows. That is the whole install.

Everything below is the detail around that line: what to check first, what you will see,
and what to do afterwards.

---

## 0. What you are installing

One **office PC** runs the whole system. Everyone else — owner, operators, checkers — opens
it in a browser on their phone or laptop. There is no cloud server and no monthly bill; the
business data never leaves that PC except as backups you take deliberately.

```
   [ owner's phone ]   [ operator's phone ]   [ laptop ]
            \                  |                 /
             \_________________|________________/
                               |  https, over Tailscale (private network)
                               |
                    +------------------------+
                    |  OFFICE PC (Windows)   |
                    |                        |
                    |  Windows service       |  <- starts with Windows, restarts on crash
                    |    +- supervisor       |  <- installs updates, rolls back failures
                    |        +- the app      |  <- its own Node + SQLite, port 8787
                    |                        |
                    |  C:\bharti\data\       |  <- app.db, photos, backups
                    |     THE BUSINESS       |     never touched by an update
                    +------------------------+
```

**The one thing to internalise:** `C:\bharti\data\` **is** the business. Everything else can
be deleted and reinstalled with the one line above. That folder cannot. Every instruction
about backups exists for this reason.

**Nothing needs installing first.** No Node, no Git, no GitHub account, no access token —
each release carries everything it needs.

---

## 1. Before you go to the office

### 1.1 Developer — check the release feed is live (once)

The one-line install downloads from the **public** release feed. Before the first visit,
confirm a release is actually there:

1. Open **https://github.com/iodex99/bharti-releases/releases** in a browser.
2. You should see a release (e.g. `v1.0.30`) with four files: `bharti-app-v….zip`,
   `install.ps1`, `install.cmd`, `checksums.txt`.

**If the page is empty**, the source repo is missing its `RELEASES_REPO_TOKEN` secret, so CI
has been publishing to the private repo instead (each run says so in a yellow warning). Fix
it once:

1. GitHub → **Settings → Developer settings → Fine-grained tokens → Generate new token**.
   Repository access: **only `bharti-releases`**. Permissions → **Contents: Read and write**.
   Set the longest expiry offered.
2. In **`bharti-enterprise-app`** → **Settings → Secrets and variables → Actions → New
   repository secret**: name `RELEASES_REPO_TOKEN`, value = that token.
3. Re-run the latest **Release** workflow (Actions tab → Release → *Re-run all jobs*), or
   push any commit. Check the releases page again.

This token belongs to CI only. The office PC never needs it.

### 1.2 Things to have in hand

- [ ] **The office PC**: Windows 11, or Windows 10 version 1803 or later, 64-bit, 8 GB RAM,
      ~20 GB free. Any ordinary desktop will do.
- [ ] **An administrator account** on that PC (or someone who can type its password when
      Windows asks).
- [ ] **One business Google account** to own the Tailscale network and receive backups.
      Agree with the owner *now* whose account it is. Never a staff member's personal
      account — staff leave.
- [ ] **Office Wi-Fi password.**

### 1.3 Only if the office has no internet — a USB stick

From the releases page in 1.1, download these three files onto a USB stick, **in the same
folder**:

- [ ] `install.cmd`
- [ ] `install.ps1`
- [ ] `bharti-app-v….zip` (~70 MB)

---

## 2. Prepare the office PC

### 2.1 Stop it going to sleep — do this first

This PC is now a server. If it sleeps, the app stops for everyone and nobody will know why.
This is the most common cause of "the system is down" calls.

**Settings → System → Power & battery → Screen and sleep** → **Sleep: Never**. (Turning the
*screen* off is fine — the screen is not the computer.)

Windows keeps a second set of sleep settings that can override the first. Open PowerShell
**as administrator** (Start → type `PowerShell` → *Run as administrator*) and run:

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /hibernate off
```

If the BIOS offers **"AC Power Recovery"** (or similar), set it to power on after a power
cut, so the PC comes back by itself.

### 2.2 Set the clock

**Settings → Time & language → Date & time** → time zone **(UTC+05:30) Chennai, Kolkata,
Mumbai, New Delhi**, "Set time automatically" **on**. (Business dates are IST in code anyway;
this just keeps logs and audit times readable.)

---

## 3. Install

### 3.1 With internet — one line

1. Click **Start**, type **PowerShell**, open **Windows PowerShell**. (An ordinary window is
   fine — the installer asks for administrator rights itself.)
2. Paste this line and press **Enter**:

   ```powershell
   irm https://github.com/iodex99/bharti-releases/releases/latest/download/install.ps1 | iex
   ```

3. Windows asks *"Do you want to allow this app to make changes to your device?"* → **Yes**.
4. A second, blue window opens and does the install. Downloading takes a minute or two.

### 3.2 Without internet — double-click

1. Plug in the USB stick from 1.3.
2. Open the folder and **double-click `install.cmd`**.
3. Windows asks for permission → **Yes**.

It finds the zip sitting next to it and uses that instead of downloading.

> If Windows warns about running a file that came from the internet, choose **Run** (or
> **More info → Run anyway**). Windows does this for any downloaded script.

### 3.3 What you will see

```
Bharti Enterprises - installing on this PC

[Getting the application]
  asking iodex99/bharti-releases for the latest version...
  downloading bharti-app-v1.0.30.zip (71 MB) - this can take a few minutes...
  download verified
  version v1.0.30

[Installing into C:\bharti]
  Node v24.x.x (shipped with the release)

[Starting the service]
  registered "Bharti Enterprises App" (starts with Windows)
  running

[Checking it answers]

  ============================================================
   INSTALLED AND RUNNING  -  v1.0.30
   Open http://localhost:8787  (shortcut on the desktop)
  ============================================================

  FIRST SIGN-IN - write this down, you will set a new password straight away:
    username:  admin
    password:  3f9a1c07
```

**Write the username and password down now.** Then press **Enter** to close the window.

The installer also puts a **Bharti Enterprises** shortcut on the desktop.

### 3.4 What it did

- Created `C:\bharti` (app, logs, data).
- Downloaded the latest release and **verified its checksum**.
- Registered the **Bharti Enterprises App** Windows service, which starts with Windows and
  restarts itself if it ever crashes.
- Waited until the app actually answered before saying it was done.

If it ends with **INSTALL DID NOT FINISH** instead, the red line under it says why. See
Part 11.

---

## 4. First sign-in

1. Double-click the **Bharti Enterprises** desktop shortcut (or open
   `http://localhost:8787`).
2. Sign in with the username and password from 3.3. The app makes you choose a new password
   immediately — **set the owner's real password with them sitting there**.
3. The setup screen offers **Start fresh** (a first install — choose this) or **Move from
   another computer** (only when replacing a PC, Part 9).
4. Delete `C:\bharti\data\initial-admin-password.txt`. It holds that first password, which
   is no longer in use.

---

## 5. Remote access for phones (Tailscale)

Staff need the app from their own phones, including on mobile data. Tailscale is free, needs
no domain name, and never exposes the app to the public internet: only devices signed into
your private network can reach it.

**On the office PC**, in PowerShell **as administrator**:

```powershell
winget install Tailscale.Tailscale
tailscale up
```

`tailscale up` opens a browser — sign in with the **business Google account** from 1.2. Then:

```powershell
tailscale serve --bg localhost:8787
tailscale dns status
```

`dns status` shows the PC's name, e.g. `office-pc.tail1a2b3c.ts.net`. **Write it down — this
is the address the whole business will use.**

If `tailscale serve` complains about HTTPS: open the Tailscale admin console → **DNS** →
enable **MagicDNS** and **HTTPS Certificates** once, then run it again.

**On each staff phone:**

1. Install **Tailscale** from the Play Store / App Store.
2. Sign in with the **same business account**, and turn the VPN switch on.
3. Open `https://office-pc.….ts.net` in Chrome or Safari.
4. Menu → **Add to Home Screen**. It now opens like an app.

**Test it properly:** turn Wi-Fi **off** on one phone and load the app on mobile data. If
that works, remote access is done.

---

## 6. Set the business up (with the owner)

The machine is ready; the business isn't yet. Sit with the owner — most of this is their
information. Order matters: each step depends on the one before.

1. **Offices** (Admin → Offices) — only if there is more than one location. Each office's
   short code prefixes its document numbers (`BR-RM-0001`). Choose codes carefully; they
   appear on every document for ever.
2. **Users** (Admin → Users) — one account per person, with a temporary password. Pin
   operators to the office they work in. **Have everyone sign in once while you are still
   there** and set their own password — accounts nobody has ever used are the number one
   support call in week one.
3. **Masters** — colours, sizes, vendors, contractors, staff.
   - There is **no models master**: the code is typed at cutting, and its photo follows it.
   - Checkers and packers carry a **per-dozen rate** — their pay is calculated from it.
   - Add **payment QR photos** for contractors and staff now; it saves hunting later.
4. **Opening balances** (Admin → Opening Balances) — today's physical stock from the paper
   registers, per office and per stage. RAW cloth takes **yards and width**.

   **This is the highest-stakes step of the whole install.** Every report and every
   reconciliation is measured from these numbers. Do it on a quiet day, straight after a
   physical count. A wrong number here looks like a real discrepancy for months.
5. **Check:** Inventory matches what is physically in the room, in every office, and
   **Admin → System Health** shows every check green.

---

## 7. Backups — before go-live, not after

The app already takes care of itself:

- **Every day at 13:00 IST** it backs up into `C:\bharti\data\backups` (kept 30 days; if the
  PC was off at 13:00 it catches up when it starts).
- **Before every update** it takes another copy.

All of that is on the same PC — useless if the PC is stolen, its disk dies, or the office
floods. **One copy must leave the building.**

1. **Administration → Backups → Download complete backup** — one `.zip` with the database
   **and every photo**.
2. Put it on Google Drive (business account) or a USB stick that goes home with someone.
3. Agree **who does this, weekly**, and write their name in the handover notes. A routine
   with nobody's name against it does not happen.

Easiest of all: install **Google Drive for Desktop** on the office PC under the business
account and save complete backups into it — then the off-site copy happens by itself.

---

## 8. Updates happen by themselves

Nobody at the office has to do anything.

```
  developer pushes -> CI builds and runs every test -> public release
                                                            |
                      office PC notices within a minute  <--+
                                                            |
                      waits until nobody has worked for 3 minutes
                                                            |
                      backs up the database, swaps version, health-checks
                                                            |
                      open browsers reload themselves on the new version
```

- A push reaches the office in **6–10 minutes** — nearly all of it CI.
- It waits for a quiet moment so nobody loses a half-typed form. Screens that refresh on a
  timer (dashboard, stock) don't count as somebody working, so a browser left open on a
  desk can't hold updates off.
- If a new version fails to start, it **rolls back automatically**, database included.
- **Admin → System Health** can switch automatic updates off or change the 3-minute wait.
  An admin can also press **Update now** at any time.

---

## 9. Repair, manual update, or a new PC

**Repair or update by hand:** run the same one line again (or double-click `install.cmd`
again). It installs the newest release over the top, and is built to be safe on a live
system:

- the running copy keeps serving while the new one downloads;
- the database is copied to `data\backups\pre-update-install-…` before anything changes;
- if anything goes wrong, the previous version **and** the database are put back and
  started again — the office is never left without a working copy.

**Replacing the office PC:**

1. On the **new** PC: Parts 2 and 3, exactly as a first install.
2. On the **old** PC: **Backups → Download complete backup**.
3. On the new PC, sign in as admin → **Move from another computer** → choose that zip →
   type `RESTORE`. Accounts, masters, the full ledger, the audit trail and every photo come
   across; everyone keeps their password.
4. Check **System Health** is green and Inventory matches.
5. Move Tailscale over (`tailscale up` with the same account, then
   `tailscale serve --bg localhost:8787`).

**Keep the old PC untouched until the new one is verified.**

---

## 10. Leave this with the owner

One page, taped beside the office PC:

- The app address: `https://office-pc.….ts.net`
- **Never switch this PC off, and never let it sleep.**
- The app updates itself — there is never anything to install.
- Who takes the weekly backup, and where it goes.
- Your phone number.
- *"If the app says a self-check failed: stop entering data and call."*

---

## 11. When something goes wrong

Two files explain almost everything: `C:\bharti\logs\supervisor.log` (versions, updates,
restarts) and `C:\bharti\logs\app.log` (the app itself).

| You see | Do this |
|---|---|
| `irm : The request was aborted: The connection was closed unexpectedly.` | Misleading wording: it is GitHub saying **404 — not found**. The release feed has no `install.ps1` yet. See 1.1 (check the releases page; set `RELEASES_REPO_TOKEN`). Not a network or TLS problem. |
| "Could not download the installer … no release has been published yet" | The feed is empty — see 1.1. Or the PC is offline: use 3.2. |
| "Could not create SSL/TLS secure channel" (old Windows 10) | Paste `[Net.ServicePointManager]::SecurityProtocol = 'Tls12'` first, then the one line again. |
| Antivirus blocks the one line | Use the double-click install (3.2) — same result. |
| "Administrator permission was not given" | Run it again and choose **Yes**. Needs an administrator account. |
| INSTALL DID NOT FINISH | Read the red line. The previous version (if any) has been put back. Fix, run again. |
| Nothing loads, on any device | `Get-Service bharti-app` — if not Running: `Start-Service bharti-app`, then read `supervisor.log`. |
| Works in the office, not outside | Tailscale off on that phone, or not running on the PC: `tailscale status`, `tailscale serve status`. |
| Worked yesterday, dead this morning | The PC slept or was switched off. Re-do 2.1. |
| Updates never arrive | Is the release on the feed (1.1)? Is auto-update off in System Health? Then `supervisor.log`. |
| An update is "waiting" | Somebody is working. It applies at the first 3-minute quiet gap, or press **Update now**. |
| System Health shows a failure | **Stop entering data.** Take a manual backup, then call the developer. |
| Disk filling up | Safe to delete: `C:\bharti\tmp`, release folders beyond the newest 3, old `data\backups`. **Never** `data\app.db`. |

---

## 12. Go-live checklist

**The machine**

1. ☐ Sleep and hibernate off; PC comes back on its own after a power cut
2. ☐ Installer finished with a green **INSTALLED AND RUNNING**
3. ☐ **Restart the PC** and check the app comes back by itself — this is the whole point of
   the service; don't skip it

**Access**

4. ☐ First password changed; `initial-admin-password.txt` deleted
5. ☐ Tailscale serving HTTPS; app opens on a phone **on mobile data, not office Wi-Fi**
6. ☐ Every staff phone has Tailscale and the app on its home screen

**The business data**

7. ☐ Offices configured (if more than one)
8. ☐ Users created, pinned to the right office, **each signed in once in front of you**
9. ☐ Masters entered — with per-dozen rates and payment QRs
10. ☐ Opening balances entered; **Inventory matches the physical count**
11. ☐ System Health: every check green

**Safety net**

12. ☐ Complete backup downloaded and stored **off the PC**
13. ☐ Weekly backup routine agreed, with a named person
14. ☐ Watch one update arrive by itself: push a trivial change, confirm the PC applies it and
    the data is intact

**People**

15. ☐ Owner walked through the dashboard, reports and Backups screen
16. ☐ Staff walked through [`USER_GUIDE.md`](USER_GUIDE.md) on their own phones
17. ☐ Everyone knows: "something looks wrong" means **stop and call**, not "carry on"
