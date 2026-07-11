/**
 * DEMO database seeder — for giving demos, completely separate from real data.
 *
 * - Writes to its own database folder (default: <repo>/data-demo — never data/).
 * - Wipes and rebuilds that folder every run, so the demo always starts fresh.
 * - Drives ~3 months of realistic business THROUGH THE SERVICE LAYER (never raw
 *   ledger writes), then proves itself with the reconciliation self-check.
 *
 * Usage:
 *   npm run seed:demo        # build/refresh the demo database
 *   npm run dev:demo         # run the app against it (same ports as dev)
 *   ...delete data-demo/     # demo gone; real data was never touched
 *
 * Sign-in: admin / Admin@123 · operator / Operator@123 · owner / Owner@123
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// MUST happen before any app import (config reads env at import time)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
process.env.DATA_DIR ??= path.join(repoRoot, 'data-demo');
const dataDir = path.resolve(process.env.DATA_DIR);
if (path.resolve(repoRoot, 'data') === dataDir) {
  console.error('Refusing to seed DEMO data into the real data/ directory.');
  process.exit(1);
}
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

const { getDb, closeDb } = await import('./connection');
const { migrate } = await import('./migrate');
const { hashPassword } = await import('../services/auth.service');
const { createPurchase, voidPurchase } = await import('../services/purchases.service');
const { createOpeningBalance } = await import('../services/opening.service');
const { createCuttingPlan, recordActuals } = await import('../services/cutting.service');
const { createJobCard, createReceipt, closeJobWithDiscrepancy } = await import(
  '../services/jobs.service'
);
const { createPayment } = await import('../services/contractors.service');
const { createCheckIssue, recordCheckResult } = await import('../services/checking.service');
const { createPackIssue, recordPackResult, createDispatch } = await import(
  '../services/packing.service'
);
const { runReconciliation } = await import('../services/reconciliation.service');

const db = getDb();
migrate(db);

const ADMIN = 1;
const OPERATOR = 2;

function daysAgo(n: number): string {
  const d = new Date(Date.now() - n * 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

/** All service calls must succeed — a failure means the system itself has a bug. */
function must<T extends { ok: boolean }>(result: T, what: string): T & { ok: true } {
  if (!result.ok) {
    const err = (result as { error?: string }).error;
    throw new Error(`Demo seed failed at ${what}: ${err}`);
  }
  return result as T & { ok: true };
}

// ---------------------------------------------------------------------------
// users + masters
// ---------------------------------------------------------------------------
const insertUser = db.prepare(
  `INSERT INTO users (username, password_hash, display_name, role, must_change_password)
   VALUES (?, ?, ?, ?, 0)`,
);
insertUser.run('admin', hashPassword('Admin@123'), 'Bharti Admin', 'admin');
insertUser.run('operator', hashPassword('Operator@123'), 'Om Prakash', 'operator');
insertUser.run('owner', hashPassword('Owner@123'), 'Bharti Owner', 'owner');

const ins = {
  model: db.prepare('INSERT INTO models (code, name, description, created_by) VALUES (?, ?, ?, 1)'),
  color: db.prepare('INSERT INTO colors (name, color_code, created_by) VALUES (?, ?, 1)'),
  size: db.prepare('INSERT INTO sizes (code, description, sort_order, created_by) VALUES (?, ?, ?, 1)'),
  vendor: db.prepare(
    'INSERT INTO vendors (name, contact_person, mobile, address, gstin, created_by) VALUES (?, ?, ?, ?, ?, 1)',
  ),
  contractor: db.prepare(
    'INSERT INTO contractors (name, contact_person, mobile, address, default_rate_paise_per_dozen, created_by) VALUES (?, ?, ?, ?, ?, 1)',
  ),
  staff: db.prepare('INSERT INTO staff (name, mobile, role, created_by) VALUES (?, ?, ?, 1)'),
};

ins.model.run('SCR-VEL', 'Velvet Scrunchie', 'Classic velvet, medium band');
ins.model.run('SCR-SAT', 'Satin Scrunchie', 'Glossy satin, thin band');
ins.model.run('SCR-COT', 'Cotton Print Scrunchie', 'Printed cotton, everyday wear');
ins.model.run('SCR-ORG', 'Organza Bow Scrunchie', 'Sheer organza with bow');
const MODEL = { VEL: 1, SAT: 2, COT: 3, ORG: 4 };

const colorRows: Array<[string, string]> = [
  ['Black', '#111111'],
  ['Maroon', '#800000'],
  ['Navy Blue', '#000080'],
  ['Baby Pink', '#F4C2C2'],
  ['White', '#FFFFFF'],
  ['Emerald', '#046307'],
  ['Mustard', '#E1AD01'],
  ['Lavender', '#B57EDC'],
];
for (const [name, code] of colorRows) ins.color.run(name, code);
const COLOR = { BLACK: 1, MAROON: 2, NAVY: 3, PINK: 4, WHITE: 5, EMERALD: 6, MUSTARD: 7, LAVENDER: 8 };

const sizeRows: Array<[string, string]> = [
  ['XS', 'Extra small'],
  ['S1', 'Small type 1'],
  ['S2', 'Small type 2'],
  ['L1', 'Large type 1'],
  ['XL', 'Extra large'],
];
sizeRows.forEach(([code, desc], i) => ins.size.run(code, desc, i + 1));
const SIZE = { XS: 1, S1: 2, S2: 3, L1: 4, XL: 5 };

ins.vendor.run('Sharma Textiles', 'Rakesh Sharma', '9812345678', 'Chandni Chowk, Delhi', '07AAACS1234A1Z5');
ins.vendor.run('Gupta Fabrics', 'Anil Gupta', '9823456789', 'Ring Road, Surat', '24AAACG5678B1Z3');
ins.vendor.run('Krishna Cloth House', 'Mohan Lal', '9811223344', 'Sadar Bazar, Delhi', '07AABCK9012C1Z8');
const VENDOR = { SHARMA: 1, GUPTA: 2, KRISHNA: 3 };

ins.contractor.run('Meena Stitching Works', 'Meena Devi', '9834567890', 'Karol Bagh, Delhi', 3000);
ins.contractor.run('Rafiq Tailors', 'Rafiq Ahmed', '9845678901', 'Seelampur, Delhi', 2800);
ins.contractor.run('Sunita Job Work', 'Sunita Kumari', '9856789012', 'Uttam Nagar, Delhi', 3200);
ins.contractor.run('Farah Stitching Unit', 'Farah Khan', '9867001122', 'Okhla, Delhi', 2900);
const CT = { MEENA: 1, RAFIQ: 2, SUNITA: 3, FARAH: 4 };

ins.staff.run('Pooja', '9867890123', 'checker');
ins.staff.run('Ravi', '9878901234', 'packer');
ins.staff.run('Kavita', '9889012345', 'both');
ins.staff.run('Deepa', '9890123456', 'checker');
const STAFF = { POOJA: 1, RAVI: 2, KAVITA: 3, DEEPA: 4 };

// ---------------------------------------------------------------------------
// opening balances (register carry-over at "go-live", ~90 days ago)
// ---------------------------------------------------------------------------
must(
  createOpeningBalance(
    db,
    { balanceDate: daysAgo(90), stage: 'RAW', modelId: MODEL.VEL, colorId: COLOR.BLACK, qty: 4500, note: 'register page 3', sizeId: null, contractorId: null },
    ADMIN,
    null,
  ),
  'opening RAW',
);
must(
  createOpeningBalance(
    db,
    { balanceDate: daysAgo(90), stage: 'CUT', modelId: MODEL.SAT, colorId: COLOR.PINK, sizeId: SIZE.S1, qty: 96, note: 'old cut stock', contractorId: null },
    ADMIN,
    null,
  ),
  'opening CUT',
);
must(
  createOpeningBalance(
    db,
    { balanceDate: daysAgo(90), stage: 'FG', modelId: MODEL.COT, colorId: COLOR.WHITE, sizeId: SIZE.S2, qty: 240, note: 'packed stock from before', contractorId: null },
    ADMIN,
    null,
  ),
  'opening FG',
);

// ---------------------------------------------------------------------------
// helpers to run realistic chains through the services
// ---------------------------------------------------------------------------
function purchase(days: number, vendorId: number, modelId: number, colorId: number, meters: number, ratePaise: number, notes = '') {
  return must(
    createPurchase(
      db,
      {
        purchaseDate: daysAgo(days),
        receivedDate: daysAgo(Math.max(days - 2, 0)),
        vendorId,
        modelId,
        colorId,
        qtyCm: meters * 100,
        ratePaisePerMeter: ratePaise,
        notes,
        imagePath: null,
      },
      OPERATOR,
      null,
    ),
    `purchase ${meters}m`,
  ).id;
}

function cut(
  days: number,
  purchaseId: number,
  metersUsed: number,
  lines: Array<{ sizeId: number; expectedPcs: number }>,
  actuals?: Array<{ sizeId: number; actualPcs: number; varianceReason?: string; reasonNote?: string }>,
) {
  const plan = must(
    createCuttingPlan(
      db,
      { cutDate: daysAgo(days), rawLotType: 'purchase', rawLotId: purchaseId, metersUsedCm: metersUsed * 100, notes: '', lines },
      OPERATOR,
      null,
    ),
    'cutting plan',
  );
  if (actuals) {
    must(
      recordActuals(
        db,
        plan.id,
        { lines: actuals.map((a) => ({ ...a, varianceReason: (a.varianceReason ?? null) as never, reasonNote: a.reasonNote ?? '' })) },
        OPERATOR,
        null,
      ),
      'cutting actuals',
    );
  }
  return plan.id;
}

function job(
  days: number,
  contractorId: number,
  modelId: number,
  colorId: number,
  lines: Array<{ sizeId: number; qtyIssuedPcs: number; ratePaisePerDozen: number }>,
) {
  const card = must(
    createJobCard(
      db,
      { issueDate: daysAgo(days), contractorId, modelId, colorId, notes: '', lines: lines.map((l) => ({ ...l, unitEntered: 'dozens' as const })) },
      OPERATOR,
      null,
    ),
    'job card',
  );
  const lineIds = db
    .prepare('SELECT id, size_id FROM job_card_lines WHERE job_card_id = ?')
    .all(card.id) as Array<{ id: number; size_id: number }>;
  return { id: card.id, lineId: (sizeId: number) => lineIds.find((l) => l.size_id === sizeId)!.id };
}

function receive(days: number, jobId: number, lines: Array<{ lineId: number; qtyPcs: number; returnType?: 'stitched' | 'unstitched_return'; discrepancyReason?: string }>) {
  must(
    createReceipt(
      db,
      jobId,
      {
        receiptDate: daysAgo(days),
        notes: '',
        lines: lines.map((l) => ({
          jobCardLineId: l.lineId,
          qtyPcs: l.qtyPcs,
          returnType: l.returnType ?? 'stitched',
          discrepancyReason: (l.discrepancyReason ?? null) as never,
          discrepancyNote: '',
        })),
      },
      OPERATOR,
      null,
    ),
    'receipt',
  );
}

function check(
  days: number,
  staffId: number,
  modelId: number,
  colorId: number,
  sizeId: number,
  qtyPcs: number,
  results: Array<{ days: number; passed: number; rejected?: Array<{ reason: string; qtyPcs: number }>; missing?: number }>,
) {
  const issue = must(
    createCheckIssue(db, { issueDate: daysAgo(days), staffId, modelId, colorId, sizeId, qtyPcs, notes: '' }, OPERATOR, null),
    'check issue',
  );
  for (const r of results) {
    must(
      recordCheckResult(
        db,
        issue.id,
        {
          resultDate: daysAgo(r.days),
          qtyPassed: r.passed,
          qtyRejected: (r.rejected ?? []).reduce((s, x) => s + x.qtyPcs, 0),
          qtyMissing: r.missing ?? 0,
          rejections: (r.rejected ?? []) as never,
          notes: '',
        },
        OPERATOR,
        null,
      ),
      'check result',
    );
  }
  return issue.id;
}

function pack(
  days: number,
  staffId: number,
  modelId: number,
  colorId: number,
  sizeId: number,
  qtyPcs: number,
  results: Array<{ days: number; packed: number; short?: number; shortReason?: 'damage' | 'missing' | 'other' }>,
) {
  const issue = must(
    createPackIssue(db, { issueDate: daysAgo(days), staffId, modelId, colorId, sizeId, qtyPcs, notes: '' }, OPERATOR, null),
    'pack issue',
  );
  for (const r of results) {
    must(
      recordPackResult(
        db,
        issue.id,
        { resultDate: daysAgo(r.days), qtyPacked: r.packed, qtyShort: r.short ?? 0, shortReason: r.shortReason ?? null, notes: '' },
        OPERATOR,
        null,
      ),
      'pack result',
    );
  }
  return issue.id;
}

// ---------------------------------------------------------------------------
// three months of business
// ---------------------------------------------------------------------------

// Month 1 — velvet black: a clean, fully-finished chain
const p1 = purchase(85, VENDOR.SHARMA, MODEL.VEL, COLOR.BLACK, 200, 4500, 'first velvet lot');
cut(80, p1, 120, [{ sizeId: SIZE.XS, expectedPcs: 120 }, { sizeId: SIZE.S1, expectedPcs: 180 }], [
  { sizeId: SIZE.XS, actualPcs: 114, varianceReason: 'wastage', reasonNote: 'edge damage' },
  { sizeId: SIZE.S1, actualPcs: 180 },
]);
const j1 = job(78, CT.MEENA, MODEL.VEL, COLOR.BLACK, [
  { sizeId: SIZE.XS, qtyIssuedPcs: 114, ratePaisePerDozen: 3000 },
  { sizeId: SIZE.S1, qtyIssuedPcs: 180, ratePaisePerDozen: 3000 },
]);
receive(72, j1.id, [{ lineId: j1.lineId(SIZE.XS), qtyPcs: 60 }, { lineId: j1.lineId(SIZE.S1), qtyPcs: 96 }]);
receive(66, j1.id, [{ lineId: j1.lineId(SIZE.XS), qtyPcs: 54 }, { lineId: j1.lineId(SIZE.S1), qtyPcs: 84 }]);
check(62, STAFF.POOJA, MODEL.VEL, COLOR.BLACK, SIZE.XS, 114, [
  { days: 60, passed: 108, rejected: [{ reason: 'stitching_issue', qtyPcs: 4 }], missing: 2 },
]);
check(62, STAFF.KAVITA, MODEL.VEL, COLOR.BLACK, SIZE.S1, 180, [
  { days: 59, passed: 96, rejected: [{ reason: 'elastic_issue', qtyPcs: 6 }] },
  { days: 57, passed: 78 },
]);
pack(55, STAFF.RAVI, MODEL.VEL, COLOR.BLACK, SIZE.XS, 108, [{ days: 53, packed: 108 }]);
pack(55, STAFF.KAVITA, MODEL.VEL, COLOR.BLACK, SIZE.S1, 174, [{ days: 52, packed: 168, short: 6, shortReason: 'damage' }]);
must(
  createDispatch(db, { dispatchDate: daysAgo(45), modelId: MODEL.VEL, colorId: COLOR.BLACK, sizeId: SIZE.XS, qtyPcs: 96, notes: 'Karol Bagh shop order' }, ADMIN, null),
  'dispatch 1',
);

// Month 1 — satin maroon: excess receipt story
const p2 = purchase(75, VENDOR.GUPTA, MODEL.SAT, COLOR.MAROON, 150, 5200);
cut(70, p2, 90, [{ sizeId: SIZE.S2, expectedPcs: 216 }], [
  { sizeId: SIZE.S2, actualPcs: 228, varianceReason: 'better_yield', reasonNote: 'tight nesting' },
]);
const j2 = job(68, CT.RAFIQ, MODEL.SAT, COLOR.MAROON, [{ sizeId: SIZE.S2, qtyIssuedPcs: 228, ratePaisePerDozen: 2800 }]);
receive(60, j2.id, [{ lineId: j2.lineId(SIZE.S2), qtyPcs: 120 }]);
receive(54, j2.id, [
  { lineId: j2.lineId(SIZE.S2), qtyPcs: 114, discrepancyReason: 'other' }, // 6 extra
]);
check(50, STAFF.DEEPA, MODEL.SAT, COLOR.MAROON, SIZE.S2, 234, [
  { days: 48, passed: 222, rejected: [{ reason: 'color_defect', qtyPcs: 10 }], missing: 2 },
]);
pack(46, STAFF.RAVI, MODEL.SAT, COLOR.MAROON, SIZE.S2, 222, [{ days: 44, packed: 222 }]);
must(
  createDispatch(db, { dispatchDate: daysAgo(40), modelId: MODEL.SAT, colorId: COLOR.MAROON, sizeId: SIZE.S2, qtyPcs: 180, notes: 'Sadar Bazar wholesale' }, ADMIN, null),
  'dispatch 2',
);

// Month 2 — cotton navy: unstitched return + shortage close
const p3 = purchase(55, VENDOR.KRISHNA, MODEL.COT, COLOR.NAVY, 180, 3800);
cut(50, p3, 100, [{ sizeId: SIZE.L1, expectedPcs: 240 }], [
  { sizeId: SIZE.L1, actualPcs: 236, varianceReason: 'measurement_error' },
]);
const j3 = job(48, CT.SUNITA, MODEL.COT, COLOR.NAVY, [{ sizeId: SIZE.L1, qtyIssuedPcs: 236, ratePaisePerDozen: 3200 }]);
receive(42, j3.id, [{ lineId: j3.lineId(SIZE.L1), qtyPcs: 180 }]);
receive(38, j3.id, [{ lineId: j3.lineId(SIZE.L1), qtyPcs: 24, returnType: 'unstitched_return' }]); // cloth back
must(
  closeJobWithDiscrepancy(db, j3.id, { reason: 'missing_pieces', note: 'Sunita could not account for 32 pcs' }, ADMIN, null),
  'close j3 short',
);
check(35, STAFF.POOJA, MODEL.COT, COLOR.NAVY, SIZE.L1, 180, [{ days: 33, passed: 176, rejected: [{ reason: 'damage', qtyPcs: 4 }] }]);
pack(30, STAFF.KAVITA, MODEL.COT, COLOR.NAVY, SIZE.L1, 176, [{ days: 28, packed: 176 }]);

// Month 2 — velvet emerald: mid-pipeline (in checking now)
const p4 = purchase(40, VENDOR.SHARMA, MODEL.VEL, COLOR.EMERALD, 120, 4600);
cut(34, p4, 80, [{ sizeId: SIZE.S1, expectedPcs: 192 }], [{ sizeId: SIZE.S1, actualPcs: 192 }]);
const j4 = job(32, CT.MEENA, MODEL.VEL, COLOR.EMERALD, [{ sizeId: SIZE.S1, qtyIssuedPcs: 192, ratePaisePerDozen: 3000 }]);
receive(24, j4.id, [{ lineId: j4.lineId(SIZE.S1), qtyPcs: 192 }]);
check(20, STAFF.DEEPA, MODEL.VEL, COLOR.EMERALD, SIZE.S1, 192, [{ days: 18, passed: 120 }]); // 72 still with Deepa

// Month 3 — organza lavender: cut, partially with contractor
const p5 = purchase(25, VENDOR.GUPTA, MODEL.ORG, COLOR.LAVENDER, 90, 6100, 'festival order fabric');
cut(20, p5, 60, [{ sizeId: SIZE.XL, expectedPcs: 132 }, { sizeId: SIZE.L1, expectedPcs: 48 }], [
  { sizeId: SIZE.XL, actualPcs: 132 },
  { sizeId: SIZE.L1, actualPcs: 44, varianceReason: 'production_loss', reasonNote: 'fray on selvedge' },
  { sizeId: SIZE.S2, actualPcs: 10, varianceReason: 'other', reasonNote: 'offcuts salvaged as S2' },
]);
const j5 = job(18, CT.FARAH, MODEL.ORG, COLOR.LAVENDER, [{ sizeId: SIZE.XL, qtyIssuedPcs: 132, ratePaisePerDozen: 2900 }]);
receive(10, j5.id, [{ lineId: j5.lineId(SIZE.XL), qtyPcs: 60 }]); // partially received

// A DELAYED job for the alert panel: issued 24 days ago, nothing back yet
const p6 = purchase(30, VENDOR.KRISHNA, MODEL.COT, COLOR.MUSTARD, 100, 3900);
cut(27, p6, 70, [{ sizeId: SIZE.S2, expectedPcs: 168 }], [{ sizeId: SIZE.S2, actualPcs: 168 }]);
const j6 = job(24, CT.RAFIQ, MODEL.COT, COLOR.MUSTARD, [{ sizeId: SIZE.S2, qtyIssuedPcs: 168, ratePaisePerDozen: 2800 }]);
void j6;

// Fresh activity this week: new purchase + a still-planned cutting batch
const p7 = purchase(4, VENDOR.SHARMA, MODEL.SAT, COLOR.PINK, 160, 5300, 'summer collection');
cut(1, p7, 90, [{ sizeId: SIZE.XS, expectedPcs: 120 }, { sizeId: SIZE.S1, expectedPcs: 144 }]); // planned, no actuals yet
purchase(2, VENDOR.GUPTA, MODEL.VEL, COLOR.WHITE, 140, 4700, 'wedding season stock');

// A voided purchase (typo demo — appears in audit + voided list)
const pOops = purchase(15, VENDOR.KRISHNA, MODEL.ORG, COLOR.WHITE, 500, 6100, 'typo: was meant to be 50m');
must(voidPurchase(db, pOops, 'entered 500m instead of 50m', ADMIN, null), 'void pOops');
purchase(15, VENDOR.KRISHNA, MODEL.ORG, COLOR.WHITE, 50, 6100, 're-entered correctly');

// An open pack issue (goods with the packer right now)
pack(3, STAFF.RAVI, MODEL.VEL, COLOR.EMERALD, SIZE.S1, 60, [{ days: 2, packed: 36 }]); // 24 pending

// Payments: Meena mostly settled, others carry dues
must(createPayment(db, { contractorId: CT.MEENA, paymentDate: daysAgo(50), amountPaise: 50000, mode: 'upi', reference: 'UPI-4471', notes: '' }, OPERATOR, null), 'pay1');
must(createPayment(db, { contractorId: CT.MEENA, paymentDate: daysAgo(12), amountPaise: 20000, mode: 'cash', reference: '', notes: 'advance adjusted' }, OPERATOR, null), 'pay2');
must(createPayment(db, { contractorId: CT.RAFIQ, paymentDate: daysAgo(30), amountPaise: 30000, mode: 'bank_transfer', reference: 'NEFT-88123', notes: '' }, OPERATOR, null), 'pay3');
must(createPayment(db, { contractorId: CT.SUNITA, paymentDate: daysAgo(20), amountPaise: 25000, mode: 'cash', reference: '', notes: '' }, OPERATOR, null), 'pay4');

// ---------------------------------------------------------------------------
// prove the demo database obeys every conservation law
// ---------------------------------------------------------------------------
const recon = runReconciliation(db);
const totals = db
  .prepare('SELECT stage, SUM(qty) AS q FROM stock_ledger GROUP BY stage ORDER BY stage')
  .all() as Array<{ stage: string; q: number }>;

console.log('\n[demo] stock by stage:');
for (const t of totals) console.log(`  ${t.stage.padEnd(9)} ${t.q}${t.stage === 'RAW' ? ' cm' : ' pcs'}`);
console.log('\n[demo] reconciliation:');
for (const c of recon.checks) console.log(`  ${c.ok ? 'OK ' : 'FAIL'} ${c.name} — ${c.detail}`);

closeDb();

if (!recon.ok) {
  console.error('\n[demo] RECONCILIATION FAILED — the seed found a real bug.');
  process.exit(1);
}
console.log(`\n[demo] demo database ready at ${dataDir}`);
console.log('[demo] run it with:  npm run dev:demo   (sign in: admin / Admin@123)');
console.log('[demo] remove it with: delete the data-demo folder — real data is untouched.');
