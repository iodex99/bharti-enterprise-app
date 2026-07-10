# Project Context

## The business

**Bharti Enterprises** manufactures scrunchies (hair bands) in India. Production is
contractor-based job work:

1. **Purchase** cloth (measured in meters) from vendors.
2. **Cut** cloth in-house into pieces for specific model/color/size combinations
   (sizes are custom codes: XS, S1, S2, L1, XL…). Output counted in dozens/pieces.
3. **Issue** cut pieces to outside **contractors** who stitch them (paid per dozen).
4. Contractors return stitched goods in **partial deliveries**; shortages/excess happen
   and must be tracked with reasons.
5. **Checkers** inspect returned goods (pass / reject / missing, with reasons).
6. **Packers** pack passed goods (checker and packer may be the same person).
7. Packed goods become **Finished Goods** inventory ready for sale.

Everything was previously tracked in paper registers. The pain points: no live inventory,
no contractor accountability, no loss visibility, no traceability.

## What this system does

Replaces the registers with a web app giving:

- Live inventory at **seven stages**: RAW (meters), CUT, WIP (with contractors),
  CHECKING, PACKING, FG, REJECTED.
- Full **traceability**: any finished-goods batch → packer → checker → contractor →
  cutting batch → cloth purchase → vendor.
- **Discrepancy tracking** with mandatory reasons at every hand-off.
- **Contractor accountability**: performance analytics, payment dues.
- **Owner dashboard** + ~15 filterable reports, all Excel-exportable.
- **Audit trail** on every change; no hard deletes ever.

## Users

| Role | Access |
|---|---|
| Admin | Everything: users, masters, overrides, voids, closing discrepant jobs, updates |
| Operator | Enter transactions; cannot delete/void/override or modify completed documents |
| Owner | Read-only: dashboard, reports, stock views, traceability |

## Deployment reality

- Runs on ONE local office Windows PC; users reach it from anywhere via **Cloudflare Tunnel**
  on phones/tablets/laptops.
- Developer pushes to GitHub (`iodex99/bharti-enterprise-app`) → GitHub Actions builds a
  Release → the running app shows an "Update available" banner → Admin clicks once → the
  app updates itself and restarts. **`data/` (SQLite DB, uploads, backups) is never touched.**

## Terminology

- **Dozen (dz)** = 12 pieces; quantities shown as e.g. "2dz 6pc". Stored as integer pieces.
- **Job card** — a work order issued to one contractor (may contain multiple sizes).
- **Batch** — any traceable lot (purchase RM-0001, cutting CUT-0003, …).
- **Discrepancy** — any difference between what was expected/issued and what arrived.
- Money in ₹ (stored as integer paise); cloth in meters (stored as integer cm);
  dates displayed DD/MM/YYYY.
