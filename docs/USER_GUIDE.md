# User Guide — Bharti Enterprises System

Written for the people using the app daily. Open the app link in any phone, tablet or
computer browser. On a phone you can **install it like an app**: open the browser menu →
"Add to Home Screen" / "Install app".

## Signing in

Enter the username and password given by the Admin. The first sign-in asks you to set a
new password (at least 8 characters with letters and numbers).

| Role | What you can do |
|---|---|
| **Admin** | Everything: users, masters, corrections (voids), closing problem jobs, updates, settings |
| **Operator** | Daily entries: purchases, cutting, job work, receipts, checking, packing, payments |
| **Owner** | See everything (dashboard, reports, stock, traceability) — read-only |

## Entering quantities

- Stitched goods: **dozens + pieces** — `2 dz 6 pc` means 30 pieces.
- Cloth: **meters**, up to 2 decimals (e.g. `125.5`).
- Money: **₹**, up to paise (e.g. `45.50`).
- Dates show as DD/MM/YYYY. You can backdate an entry if it was written in the register
  earlier — reports follow the date you enter.

## The production flow (who does what)

```
Purchases → Cutting → Job Work → Checking → Packing → Finished Goods → Dispatch
```

### 1. Purchases (cloth in)
**Production → Purchases → + New purchase.** Pick vendor, model, color; enter meters and
rate; the total is calculated automatically. Attach a photo of the bill if you like.
The cloth immediately appears in **Inventory → Raw Material**.

### 2. Cutting
**Production → Cutting → + New cutting plan.** Pick the exact cloth batch (the list shows
what's available in each), enter how many meters you will use and the expected dozens per
size. When cutting is finished, press **Record actuals** on the batch and enter what was
really cut. If actual differs from expected — even if MORE came out — you must pick a
reason. The cut pieces appear in **Inventory → Cut Cloth**.

### 3. Job Work (contractors)
**Production → Job Work → + New job card.** Pick the contractor; their rate fills in
automatically but can be changed per size line. The system refuses to issue more than the
cut stock available.

When goods come back, open the job → **Receive goods**. Partial deliveries are normal —
receive 2 dz today, 3 dz tomorrow; the job stays open until everything is settled. Two
special cases:
- **Unstitched return** — contractor returns cut-but-unstitched pieces; they go back to
  Cut Cloth stock.
- **More than pending** — the app asks for a reason and records an excess discrepancy.

When received + returned equals issued, the job completes **by itself**. If pieces are
missing and the contractor cannot return them, only the **Admin** can close the job
("Close with discrepancy") — the shortage is written off and recorded against the
contractor permanently.

### 4. Checking
**Production → Checking → + Issue to checker.** Only staff marked as checkers appear.
Record results in sessions (today 3 dz, tomorrow 2 dz): **passed**, **rejected** (with
reasons — stitching, elastic, color, damage), **missing**. Passed pieces wait for packing;
rejected pieces sit in the Rejected stock so nothing disappears silently.

### 5. Packing
**Production → Packing → + Issue to packer.** Works exactly like checking. If your checker
also packs, give that person the role "Checker + Packer" in Masters and they appear in
both lists. Packed pieces become **Finished Goods**.

### 6. Dispatches (Admin)
**Production → Dispatches.** Records finished goods leaving for sale so FG stock stays
true.

## Contractors page

**Production → Contractors** shows every contractor's scorecard: how much they've been
given, returned, lost (shortage), extra (excess), their discrepancy %, average turnaround
days, the job-work cost earned and **dues** (cost − payments). Record payments here
(cash/UPI/bank/cheque).

## Finding things fast

Every list has instant **search**, **dropdown filters** (vendor, contractor, model,
color, size, status, checker/packer…), a **date range**, and **click-to-sort column
headings** (click once for ascending, again for descending).

## Inventory

**Inventory** shows live stock at all seven stages. Nothing here can be edited by hand —
stock only moves when a transaction is recorded. That is what makes the numbers
trustworthy.

## Reports & Excel

**Reports** — pick a report, set filters, then **⬇ Download Excel** or **🖨 Print**.
At the top of the page, the **Complete Business Report** downloads EVERYTHING in one
document: a visual HTML report (opens in any browser, prints cleanly) or an Excel
workbook with one sheet per report — both with an optional date range.
Everything the owner asked for lives here: stock, expected-vs-actual cutting, contractor
performance and pending work, checker performance, rejection analysis, all losses,
inventory aging, monthly production trends.

## Traceability

**Traceability** answers "where did this batch come from?" Pick any finished-goods batch
and see who packed it, who checked it, which contractor stitched it, which cutting batch
it came from, and which vendor's cloth was used — or start from a purchase and look
forward.

## Fixing mistakes

Nothing is ever deleted. If a document was entered wrongly:
- Financial details of a purchase (rate, notes, photo) can be edited — changes are logged.
- Quantities/model/color cannot be edited once saved. The **Admin voids** the document
  (reason required) and it is re-entered correctly. Voiding puts the stock back exactly
  as it was, and is blocked if later steps already used the material (void those first).

Every change is recorded in **Administration → Audit Log** — who, when, and what changed.

## Giving a demo (separate demo data)

**Admin → System Health → Demo mode** has one-click buttons:

- **Enter demo mode** — switches the whole app onto a separate sample database with
  ~3 months of realistic business (every screen, chart, alert and report has data).
  Everyone is signed out; sign in with `admin / Admin@123`. A bright **DEMO MODE**
  banner stays visible so nobody mistakes sample data for real records.
- **Rebuild fresh & enter** — resets the demo to its original state first.
- **Exit demo mode** — back to real data, sign in with your usual account.
- **Remove demo data** — deletes the demo database entirely (real data unaffected).

Anything entered during a demo stays in the demo database and vanishes with it.
Developers can also use `npm run seed:demo` + `npm run dev:demo` from a checkout.

## For the Admin

- **Users** — create accounts, set roles, deactivate instantly, reset passwords.
- **Opening Balances** — one-time entry of existing register stock at go-live.
- **Backups** — automatic daily at 1 PM; if the computer was off or the backup failed,
  it catches up by itself (hourly and whenever the app starts) until the day's backup
  exists. Also before every update. For off-site copies,
  install Google Drive for Desktop, sign in with the owner's Google account, and set the
  synced folder on the Backups page — every backup is then copied to the owner's Drive
  automatically.
- **System Health** — inventory self-checks (all should always be ✅) and the
  delayed-job threshold.
- **Updates** — when a banner says a new version is available, press **Update now**. The
  app restarts itself in under a minute; if anything goes wrong it automatically returns
  to the previous version. Data is never touched.
