# User Guide — Bharti Enterprises System

Written for the people using the app daily. **The system runs on the office computer**;
everyone opens it in a browser — on the office PC itself or from a phone using the office
link. Operators enter the day's work; the owner watches everything from anywhere.

## Signing in

Enter the username and password given by the Admin. The first sign-in asks you to set a
new password (at least 8 characters with letters and numbers).

| Role | What you can do |
|---|---|
| **Admin** | Everything: offices, users, masters, corrections (voids), closing problem jobs, updates, settings |
| **Operator** | Daily entries in THEIR office: purchases, cutting, job work, receipts, checking, packing, payments |
| **Owner** | See everything in every office (dashboard, reports, stock, traceability) — read-only |

## Offices

The business can have more than one office. **Each office's work stays separate** — its
purchases, cutting, jobs, stock and document numbers belong to it alone. Masters (colors,
sizes, vendors, contractors, staff) are shared by all offices.

- **Operators belong to one office** and always see that office's data — nothing to pick.
- **Admin and the owner** see an office selector in the top bar; pick an office and the
  whole screen shows that office's numbers. The first office uses plain document numbers
  (`RM-0001`); other offices carry their code (`BR-RM-0001`) so a document number always
  says where it belongs.
- The **Admin adds offices** at **Administration → Offices** (short code + name) and
  creates each operator's login on the **Users** page, choosing their office there.

## Entering quantities

- Stitched goods: **dozens + pieces** — `2 dz 6 pc` means 30 pieces.
- Cloth: **yards** for length, up to 2 decimals (e.g. `125.5`), and **inches** for the
  cloth width and per-piece measurements. 1 yard = 36 inches.
- Money: **₹**, up to paise (e.g. `45.50`).
- Dates show as DD/MM/YYYY. You can backdate an entry if it was written in the register
  earlier — reports follow the date you enter.

## The production flow (who does what)

```
Purchases → Cutting (code given here) → Job Work → Checking & Packing → Finished Goods → Dispatch
```

> **Ink colors, like the registers:** everywhere in the app, **blue numbers = goods going
> OUT** (issued to a contractor, checker, packer, or dispatched) and **red numbers =
> goods coming IN** (cloth purchased, goods received back) — the same convention as the
> old paper registers.

### 1. Purchases (cloth in)
**Production → Purchases → + New purchase.** Pick vendor and color; enter the **length in
yards**, the **cloth width in inches**, and the rate per yard; the total is calculated
automatically. Attach a photo of the bill if you like. **No code number is given here** —
cloth is just cloth until it is cut. It immediately appears in **Inventory → Raw
Material** (by color and vendor, with its width).

### 2. Cutting — where the code number is given
**Production → Cutting → + New cutting.** Pick the roll being cut — the list shows each
roll by its **colour, how much is left and how wide it is**, which is how you recognise
it on the shelf. For each size line:

- type the **CODE NUMBER** in the box beside the size — that code + size (e.g. `315-XS`)
  becomes the **size-code** the goods carry everywhere from here on;
- add the **product photo** there — it follows the code on every later screen;
- enter the pieces cut, the length one piece takes in **inches**, and **how many pieces
  fit side-by-side across the cloth width**.

The app works out the cloth used by itself (pieces ÷ across-the-width, times inches per
piece) and shows **how much will be left on the roll** — it refuses an entry that needs
more cloth than the roll has.

**The entry IS the cutting** — saving it takes the cloth and creates the cut pieces at
once; there is no separate "record actuals" step. While none of its pieces have been
given to a contractor, the entry can be **edited** (the batch number stays the same) or
**deleted** (the cloth goes back onto the roll). After that, only the Admin can void it.
The cut pieces appear in **Inventory → Cut Cloth** under their size-code.

### 3. Job Work (contractors)
**Production → Job Work → + Issue goods.** Pick the contractor; add lines by **code,
color and size** from cut stock. The **cost per dozen is set here** — the contractor's
usual rate fills in automatically and can be changed per line. The system refuses to
issue more than the cut stock available.

If the lines cover more than one code/color, the goods are issued together but the system
makes **a separate job card for each code + color** — so every card tracks one product,
while the contractor got everything in one go.

A job card that nothing has been received against can be **edited or deleted**.

When goods come back, open the job → **Receive goods**. **A photo of the returned goods
is required** — every code's return is photographed, and the checker refers to it later.
Partial deliveries are normal — receive 2 dz today, 3 dz tomorrow; the job stays open
until everything is settled. Two special cases:
- **Unstitched return** — contractor returns cut-but-unstitched pieces; they go back to
  Cut Cloth stock.
- **More than pending** — the app asks for a reason and records an excess discrepancy.

**What the contractor CLAIMS to have returned is not taken as final** — the received
batch goes to **"Pending for checking"** and only counts once a checker verifies it. The
job list shows an **"Awaiting check"** column so you always know how much is claimed but
not yet verified.

When received + returned equals issued, the job completes **by itself**. If pieces are
missing and the contractor cannot return them, only the **Admin** can close the job
("Close with discrepancy") — the shortage is written off and recorded against the
contractor permanently.

### 4. Checking & Packing (one page, four tabs)
**Checking** (bottom bar) has four tabs, in the order the goods move:

1. **📥 To check** — every batch back from a contractor and not yet verified: who it came
   from, the receipt number, the return photo (tap it to see it big), and how many pieces
   are waiting. Press **Issue to checker**. Any staff member can check.
2. **🔍 Checking** — batches with a checker. Press **Record result** and enter **passed**
   (or tap **All … passed**) and any **rejected pieces** with a reason — stitching,
   elastic, color, damage, **missing**, or other.
   - **Rejected pieces go straight back to the contractor** who stitched them. Their job
     card reopens, and those pieces come **off the contractor's dues** until they bring
     them back fixed — then they are checked again and paid normally. The form tells you
     this before you save.
   - **Missing** pieces are written off and **deducted from the contractor**.
   - **"packs the passed pieces now"** is ticked by default: the checker gets the passed
     pieces for packing in the same step. Untick it to choose a different packer or keep
     a bundle.
3. **📦 Packing** — passed pieces ready to pack (**Pack**: the checker is already chosen;
   or **Keep aside as a bundle** for later), packing in progress (**Record packing**, with
   an **All … packed** shortcut), and bundles kept aside.
4. **✅ Packed** — the register of finished goods: what was packed, when, by whom, and
   from which contractor's batch.

### 5. Dispatches (Admin)
**Production → Dispatches.** Records finished goods leaving for sale so FG stock stays
true.

## Money: contractors, checkers/packers, and pending dues

**Pending Dues** (bottom bar → Dues) has four tabs: **Pending** (who is owed what right
now), **Contractors** (every contractor's scorecard — given, returned, rework, short /
excess, discrepancy %, turnaround, cost and dues), **Checkers & Packers**, and
**Payments** (every payment; the Admin can **Edit** or **Void** one).

**Tap any person to open their ledger.** It shows:
- the **balance due** at the top, with **Record payment**, **Download PDF** and, on a
  phone, **Share PDF** (send it straight on WhatsApp);
- **How this is worked out** — work received, *less* pieces sent back for rework, *less*
  missing pieces, *less* paid, = balance due;
- the breakdown **by job card** (contractors) or **by batch** (checkers/packers): pieces,
  rate per dozen, amount;
- the **account ledger** — every receipt, deduction and payment with the running balance.
Choose **This month**, **Last month** or your own dates to get a statement for a period
(it starts from the opening balance).

**Checkers and packers are paid per dozen too.** Set each person's usual rate in
**Masters → Checkers & Packers**; when a batch is allotted for checking or packing, that
rate fills in (change it for one batch if something different was agreed). Their pay
builds up from the results they record: **every piece they inspected** (passed or
rejected) and every piece they packed. Pieces marked *missing* are not paid for — those
never reached the checker.

Payments belong to the office where the work was done. If you try to pay someone in an
office they have not worked in, the app says so instead of recording money that would
never clear their dues.

**Production → Pending Dues 💰** is the money page: contractors on top,
checkers/packers below, each showing what they earned, what has been paid, **what is
still owed** and the last payment date. Press **Record payment** on any row to pay —
**part-payments with their date are the normal case**; the rest stays pending. The
payment window shows that person's **QR code** (upload it once on their master page,
under "Payment QR code") so paying by UPI is scan-and-done. The same views exist as
reports for Excel/print.

## Discrepancies (review & close the loop)

Whenever actual differs from expected anywhere — contractor excess or shortage,
missing/rejected pieces at checking, packing shortfalls — the system records a
**discrepancy** automatically. **Production → Discrepancies** (also reached from the
dashboard alerts) lists them all with the source document, size-code and
contractor/staff involved.

Once the matter is looked into, the **Admin** presses **Resolve** and writes what was
decided ("recovered from contractor", "written off", "counting error confirmed"…).
Resolving only records the review — stock was already adjusted the moment the difference
was recorded, so nothing moves again.

## On a phone

The app is built for phones first. The **bar at the bottom** takes you to Home, Jobs,
Checking and Dues in one tap; everything else is under **Menu**. Every list turns into
**one card per row** — tap a card to open it; its buttons sit underneath. Buttons and
boxes are thumb-sized, and **photos show as small pictures — tap one to see it full
screen**. On a tablet or laptop the same lists show as normal tables.

## Finding things fast

Every list has **one-tap status chips** at the top with a count on each (e.g. *In
stock · Fully used · Voided*, *With contractor · Rework due · Completed · Closed*),
instant **search**, **dropdown filters** (vendor, contractor, code, color, size,
checker/packer…), a **date range**, and sorting. On a phone the dropdowns, dates and
sorting sit behind one **Filters** button. The size-code and its photo appear on every screen the goods pass through —
cutting, job cards, checking, packing, stock, reports and traceability all speak the
same language.

## Inventory

**Inventory** shows live stock at all seven stages **for the selected office**. Nothing
here can be edited by hand — stock only moves when a transaction is recorded. That is
what makes the numbers trustworthy.

## Reports & Excel

**Reports** — pick a report, set filters, then **⬇ Download Excel** or **🖨 Print**.
At the top of the page, the **Complete Business Report** downloads EVERYTHING in one
document: a visual HTML report (opens in any browser, prints cleanly) or an Excel
workbook with one sheet per report — both with an optional date range.
Everything the owner asked for lives here: stock, the cutting register, contractor
performance and pending work, checker performance, rejection analysis, pending dues, all
losses, inventory aging, monthly production trends.

## Traceability

**Traceability** answers "where did this batch come from?" Pick any finished-goods batch
and see who packed it, who checked it, which contractor stitched it, which cutting batch
it came from, and which vendor's cloth was used — or start from a purchase and look
forward.

## Fixing mistakes

Nothing is ever deleted. If a document was entered wrongly:
Every list has an **Edit** button. What can change depends on what has happened since:
- **Before anything later uses it, everything can be corrected** — a purchase (vendor,
  color, length, width, rate…), a cutting entry, a job card, a checker's or packer's batch
  (person and quantity). The stock adjusts itself.
- **After that, the paperwork stays editable**: dates, rates, photos and notes. A job card
  that already has goods back keeps its sizes and quantities, but its **cost per dozen**
  can still be corrected — the contractor's dues update by themselves. Once some cloth of
  a purchase is cut, its color and width are fixed and the length can't go below what was
  used.
- Receipts: date, photo and notes. Opening balances: date, quantity and note (never below
  what was used).
- Payments and dispatches are corrected by the **Admin**.
- To change what a document *is* after it has been used, the **Admin voids** it (reason
  required) and it is re-entered. Voiding puts the stock back exactly as it was.

Every change is recorded in **Administration → Audit Log** — who, when, and what changed.

## Giving a demo (separate demo data)

**Admin → System Health → Demo mode** has one-click buttons:

- **Enter demo mode** — switches the whole app onto a separate sample database with
  ~3 months of realistic business across two offices (every screen, chart, alert and
  report has data). Everyone is signed out; sign in with `admin / Admin@123` (or
  `branch-op / Branch@123` to see a pinned operator's view). A bright **DEMO MODE**
  banner stays visible so nobody mistakes sample data for real records.
- **Rebuild fresh & enter** — resets the demo to its original state first.
- **Exit demo mode** — back to real data, sign in with your usual account.
- **Remove demo data** — deletes the demo database entirely (real data unaffected).

## For the Admin

- **Offices** — add an office (short code + name); its documents get the code as a
  prefix. Deactivating an office hides it from switching and blocks its operators.
- **Users** — create accounts, set roles, pick an operator's office, deactivate
  instantly, reset passwords.
- **Masters → Contractors / Checkers & Packers** — set rates per dozen and upload each
  person's payment QR code.
- **Opening Balances** — one-time entry of existing register stock at go-live, per
  office (RAW takes yards + width; stitched stages take a typed code number).
- **System Health** — inventory self-checks (all should always be ✅) and the
  delayed-job threshold.

## Backups

Everything — every record **and every photo** — is one file on the office computer.

- The app takes a **backup by itself every day**.
- **Administration → Backups → Download complete backup** saves the whole business as
  one file — keep a weekly copy in Google Drive. A cloud-synced folder can also be
  configured so backups mirror there automatically.
- **Restore** (new computer, or going back to a snapshot): feed the backup file into the
  Restore card on the same page. It shows what is inside before replacing anything and
  asks you to type RESTORE. Everyone signs in again afterwards.

## Updates

When a new version is ready, a banner appears at the top of the screen. The **Admin**
presses **Update now**: the office computer downloads the new version, checks it, backs
the data up, and restarts itself — under a minute, and nothing else to do. If the new
version fails to start, the previous one is put back automatically. Data is never part
of an update.
