/**
 * Demo dataset builder — populates a FRESH database (already migrated) with ~3 months
 * of realistic business, driven entirely through the service layer so every ledger
 * rule applies. Used by the in-app demo mode and the `npm run seed:demo` CLI.
 *
 * v2 (ADR-027…036): two offices with fully separate operations, cloth in yards with
 * width, size-codes typed at cutting (the plan IS the cutting), combined job issues
 * split into per-code cards, photos on receipts, missing-as-a-rejection-reason,
 * packing allotted from checking, and a bundle kept aside.
 *
 * Sign-in: admin / Admin@123 · operator / Operator@123 · owner / Owner@123
 */
import type { Db } from './connection';
import { hashPassword } from '../services/auth.service';
import { createPurchase, voidPurchase } from '../services/purchases.service';
import { createOpeningBalance } from '../services/opening.service';
import { createCuttingPlan } from '../services/cutting.service';
import { closeJobWithDiscrepancy, createJobIssue, createReceipt } from '../services/jobs.service';
import { createPayment } from '../services/contractors.service';
import { createCheckIssue, recordCheckResult } from '../services/checking.service';
import { createDispatch, createPackIssue, recordPackResult } from '../services/packing.service';
import { resolveDiscrepancy } from '../services/discrepancies.service';
import { getOffice, createOffice, type Office } from '../services/offices.service';
import { runReconciliation } from '../services/reconciliation.service';

const ADMIN = 1;
const OPERATOR = 2;

function daysAgo(n: number): string {
  const d = new Date(Date.now() - n * 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

function must<T extends { ok: boolean }>(result: T, what: string): T & { ok: true } {
  if (!result.ok) {
    const err = (result as { error?: string }).error;
    throw new Error(`Demo data failed at ${what}: ${err}`);
  }
  return result as T & { ok: true };
}

/** A real (tiny) webp so demo photo links actually render. */
const TINY_WEBP = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');

export function populateDemo(db: Db): ReturnType<typeof runReconciliation> {
  // ---- users (before offices — offices.created_by references users) --------
  const insertUser = db.prepare(
    `INSERT INTO users (username, password_hash, display_name, role, office_id, must_change_password)
     VALUES (?, ?, ?, ?, ?, 0)`,
  );
  insertUser.run('admin', hashPassword('Admin@123'), 'Bharti Admin', 'admin', null);
  insertUser.run('operator', hashPassword('Operator@123'), 'Om Prakash', 'operator', 1);
  insertUser.run('owner', hashPassword('Owner@123'), 'Bharti Owner', 'owner', null);

  // ---- offices (HO exists from the migration) -------------------------------
  const HO: Office = getOffice(db, 1)!;
  const brId = must(createOffice(db, { code: 'BR', name: 'Branch Office' }, ADMIN, null), 'office BR').id;
  const BR: Office = getOffice(db, brId)!;
  insertUser.run('branch-op', hashPassword('Branch@123'), 'Salim (Branch)', 'operator', BR.id);

  // ---- masters (models are NOT a master — codes are typed at cutting) -------
  const ins = {
    color: db.prepare('INSERT INTO colors (name, color_code, created_by) VALUES (?, ?, 1)'),
    size: db.prepare('INSERT INTO sizes (code, description, sort_order, created_by) VALUES (?, ?, ?, 1)'),
    vendor: db.prepare(
      'INSERT INTO vendors (name, contact_person, mobile, address, gstin, created_by) VALUES (?, ?, ?, ?, ?, 1)',
    ),
    contractor: db.prepare(
      'INSERT INTO contractors (name, contact_person, mobile, address, default_rate_paise_per_dozen, created_by) VALUES (?, ?, ?, ?, ?, 1)',
    ),
    staff: db.prepare("INSERT INTO staff (name, mobile, role, created_by) VALUES (?, ?, 'both', 1)"),
  };

  for (const [name, code] of [
    ['Black', '#111111'],
    ['Maroon', '#800000'],
    ['Navy Blue', '#000080'],
    ['Baby Pink', '#F4C2C2'],
    ['White', '#FFFFFF'],
    ['Emerald', '#046307'],
    ['Mustard', '#E1AD01'],
    ['Lavender', '#B57EDC'],
  ] as const) {
    ins.color.run(name, code);
  }
  const COLOR = { BLACK: 1, MAROON: 2, NAVY: 3, PINK: 4, WHITE: 5, EMERALD: 6, MUSTARD: 7, LAVENDER: 8 };

  (
    [
      ['XS', 'Extra small'],
      ['S1', 'Small type 1'],
      ['S2', 'Small type 2'],
      ['L1', 'Large type 1'],
      ['XL', 'Extra large'],
    ] as const
  ).forEach(([code, desc], i) => ins.size.run(code, desc, i + 1));
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

  ins.staff.run('Pooja', '9867890123');
  ins.staff.run('Ravi', '9878901234');
  ins.staff.run('Kavita', '9889012345');
  ins.staff.run('Deepa', '9890123456');
  const STAFF = { POOJA: 1, RAVI: 2, KAVITA: 3, DEEPA: 4 };

  // demo photo (a real webp) used wherever a photo is referenced
  const photo = (name: string): string => {
    const path = `/uploads/2026-01/${name.padEnd(16, '0').slice(0, 16)}.webp`;
    db.prepare(
      'INSERT OR IGNORE INTO upload_files (path, mime, size_bytes, bytes, created_by) VALUES (?, ?, ?, ?, 1)',
    ).run(path, 'image/webp', TINY_WEBP.byteLength, TINY_WEBP);
    return path;
  };

  // ---- opening balances (head office) ---------------------------------------
  must(
    createOpeningBalance(
      db,
      HO,
      // raw cloth carries no code — the code is given at cutting; length in 1/100 inch (25 yd), width 44"
      { balanceDate: daysAgo(90), stage: 'RAW', modelCode: null, colorId: COLOR.BLACK, qty: 25 * 3600, widthInchC: 4400, note: 'register page 3', sizeId: null, contractorId: null },
      ADMIN,
      null,
    ),
    'opening RAW',
  );
  must(
    createOpeningBalance(
      db,
      HO,
      { balanceDate: daysAgo(90), stage: 'CUT', modelCode: '210', colorId: COLOR.PINK, sizeId: SIZE.S1, qty: 96, note: 'old cut stock', contractorId: null, widthInchC: null },
      ADMIN,
      null,
    ),
    'opening CUT',
  );
  must(
    createOpeningBalance(
      db,
      HO,
      { balanceDate: daysAgo(90), stage: 'FG', modelCode: '330', colorId: COLOR.WHITE, sizeId: SIZE.S2, qty: 240, note: 'packed stock from before', contractorId: null, widthInchC: null },
      ADMIN,
      null,
    ),
    'opening FG',
  );

  // ---- chain helpers ---------------------------------------------------------
  // purchases carry NO code — cloth is vendor + color + yards + width
  const purchase = (
    office: Office,
    days: number,
    vendorId: number,
    colorId: number,
    yards: number,
    widthIn: number,
    ratePaisePerYard: number,
    notes = '',
  ) =>
    must(
      createPurchase(
        db,
        office,
        {
          purchaseDate: daysAgo(days),
          receivedDate: daysAgo(Math.max(days - 2, 0)),
          vendorId,
          colorId,
          lenInchC: yards * 3600,
          widthInchC: widthIn * 100,
          ratePaisePerYard,
          notes,
          imagePath: null,
        },
        OPERATOR,
        null,
      ),
      `purchase ${yards}yd`,
    ).id;

  // cutting geometry per size: cloth per piece (hundredths of an inch) + pieces across width
  const GEO: Record<number, { inchC: number; width: number }> = {
    [SIZE.XS]: { inchC: 800, width: 5 }, // 8" pieces, 5 across a 44" cloth
    [SIZE.S1]: { inchC: 900, width: 4 },
    [SIZE.S2]: { inchC: 1000, width: 4 },
    [SIZE.L1]: { inchC: 1200, width: 3 },
    [SIZE.XL]: { inchC: 1400, width: 3 },
  };

  /** The plan IS the cutting: each line carries its CODE (+ photo on first use). */
  const cut = (
    office: Office,
    days: number,
    purchaseId: number,
    lines: Array<{ sizeId: number; code: string; qtyPcs: number; withPhoto?: boolean }>,
  ) =>
    must(
      createCuttingPlan(
        db,
        office,
        {
          cutDate: daysAgo(days),
          rawLotType: 'purchase',
          rawLotId: purchaseId,
          notes: '',
          lines: lines.map((l) => ({
            sizeId: l.sizeId,
            code: l.code,
            qtyPcs: l.qtyPcs,
            clothPerPcInchC: GEO[l.sizeId]!.inchC,
            widthCount: GEO[l.sizeId]!.width,
            imagePath: l.withPhoto ? photo(`code${l.code.replace(/\W/g, '')}`) : null,
          })),
        },
        OPERATOR,
        null,
      ),
      'cutting',
    ).id;

  const modelIdOf = (code: string): number =>
    (db.prepare('SELECT id FROM models WHERE code = ? COLLATE NOCASE').get(code) as { id: number }).id;

  /** Combined issue — may span codes/colors; returns one card per (code, color). */
  const issue = (
    office: Office,
    days: number,
    contractorId: number,
    lines: Array<{ code: string; colorId: number; sizeId: number; qtyPcs: number; rate: number }>,
  ) => {
    const result = must(
      createJobIssue(
        db,
        office,
        {
          issueDate: daysAgo(days),
          contractorId,
          notes: '',
          lines: lines.map((l) => ({
            modelId: modelIdOf(l.code),
            colorId: l.colorId,
            sizeId: l.sizeId,
            qtyIssuedPcs: l.qtyPcs,
            unitEntered: 'dozens' as const,
            ratePaisePerDozen: l.rate,
          })),
        },
        OPERATOR,
        null,
      ),
      'job issue',
    );
    return {
      cards: result.cards,
      cardFor: (code: string, colorId: number) =>
        result.cards.find((c) => c.modelId === modelIdOf(code) && c.colorId === colorId)!,
      lineId: (cardId: number, sizeId: number) =>
        (
          db
            .prepare('SELECT id FROM job_card_lines WHERE job_card_id = ? AND size_id = ?')
            .get(cardId, sizeId) as { id: number }
        ).id,
    };
  };

  /** Every receipt carries a PHOTO of the returned goods (required in v2). */
  const receive = (
    office: Office,
    days: number,
    jobId: number,
    lines: Array<{ lineId: number; qtyPcs: number; returnType?: 'stitched' | 'unstitched_return'; discrepancyReason?: string }>,
  ) =>
    must(
      createReceipt(
        db,
        office,
        jobId,
        {
          receiptDate: daysAgo(days),
          imagePath: photo(`rcpt${jobId}d${days}`),
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

  /** The oldest received-but-unchecked batch of this job+size (directed checking). */
  const poolLotFor = (jobId: number, sizeId: number): number => {
    const row = db
      .prepare(
        `SELECT l.lot_id AS lotId FROM stock_ledger l
         JOIN job_receipt_lines rl ON rl.id = l.lot_id
         JOIN job_receipts r ON r.id = rl.job_receipt_id
         JOIN job_card_lines jl ON jl.id = rl.job_card_line_id
         WHERE l.stage = 'CHECKING' AND l.staff_id IS NULL AND l.lot_type = 'receipt_line'
           AND r.job_card_id = ? AND jl.size_id = ?
         GROUP BY l.lot_id HAVING SUM(l.qty) > 0 ORDER BY l.lot_id LIMIT 1`,
      )
      .get(jobId, sizeId) as { lotId: number } | undefined;
    if (!row) throw new Error(`no pending-checking batch for job ${jobId} size ${sizeId}`);
    return row.lotId;
  };

  /**
   * One check issue per received batch. v2 results: passed + ONE rejected breakdown
   * where 'missing' is just another reason in the dropdown.
   */
  const check = (
    office: Office,
    days: number,
    staffId: number,
    jobId: number,
    sizeId: number,
    qtyPcs: number,
    results: Array<{ days: number; passed: number; rejected?: Array<{ reason: string; qtyPcs: number }> }>,
  ) => {
    const ci = must(
      createCheckIssue(
        db,
        office,
        { issueDate: daysAgo(days), staffId, lotType: 'receipt_line', lotId: poolLotFor(jobId, sizeId), qtyPcs, notes: '' },
        OPERATOR,
        null,
      ),
      'check issue',
    );
    for (const r of results) {
      must(
        recordCheckResult(
          db,
          office,
          ci.id,
          {
            resultDate: daysAgo(r.days),
            qtyPassed: r.passed,
            rejections: (r.rejected ?? []) as never,
            notes: '',
          },
          OPERATOR,
          null,
        ),
        'check result',
      );
    }
    return ci.id;
  };

  /** Packing is allotted FROM a check issue (usually to the same person who checked). */
  const pack = (
    office: Office,
    days: number,
    staffId: number,
    checkIssueId: number,
    qtyPcs: number,
    results: Array<{ days: number; packed: number; short?: number; shortReason?: 'damage' | 'missing' | 'other' }>,
    opts: { kind?: 'pack' | 'bundle'; label?: string } = {},
  ) => {
    const pi = must(
      createPackIssue(
        db,
        office,
        {
          issueDate: daysAgo(days),
          staffId,
          lotType: 'check_issue',
          lotId: checkIssueId,
          qtyPcs,
          kind: opts.kind ?? 'pack',
          label: opts.label ?? '',
          notes: '',
        },
        OPERATOR,
        null,
      ),
      'pack issue',
    );
    for (const r of results) {
      must(
        recordPackResult(
          db,
          office,
          pi.id,
          { resultDate: daysAgo(r.days), qtyPacked: r.packed, qtyShort: r.short ?? 0, shortReason: r.shortReason ?? null, notes: '' },
          OPERATOR,
          null,
        ),
        'pack result',
      );
    }
    return pi.id;
  };

  // ---- three months of business (HEAD OFFICE) --------------------------------

  // Month 1 — code 315 velvet black: a clean, fully-finished chain
  const p1 = purchase(HO, 85, VENDOR.SHARMA, COLOR.BLACK, 220, 44, 4100, 'first velvet lot');
  cut(HO, 80, p1, [
    { sizeId: SIZE.XS, code: '315', qtyPcs: 120, withPhoto: true },
    { sizeId: SIZE.S1, code: '315', qtyPcs: 180 },
  ]);
  const i1 = issue(HO, 78, CT.MEENA, [
    { code: '315', colorId: COLOR.BLACK, sizeId: SIZE.XS, qtyPcs: 120, rate: 3000 },
    { code: '315', colorId: COLOR.BLACK, sizeId: SIZE.S1, qtyPcs: 180, rate: 3000 },
  ]);
  const j1 = i1.cardFor('315', COLOR.BLACK).id;
  receive(HO, 72, j1, [
    { lineId: i1.lineId(j1, SIZE.XS), qtyPcs: 60 },
    { lineId: i1.lineId(j1, SIZE.S1), qtyPcs: 96 },
  ]);
  receive(HO, 66, j1, [
    { lineId: i1.lineId(j1, SIZE.XS), qtyPcs: 60 },
    { lineId: i1.lineId(j1, SIZE.S1), qtyPcs: 84 },
  ]);
  // XS batches: 60 + 60 (114 pass, 4 reject incl. 2 missing)
  const c1 = check(HO, 62, STAFF.POOJA, j1, SIZE.XS, 60, [
    { days: 60, passed: 58, rejected: [{ reason: 'stitching_issue', qtyPcs: 2 }] },
  ]);
  const c2 = check(HO, 61, STAFF.POOJA, j1, SIZE.XS, 60, [
    { days: 60, passed: 56, rejected: [{ reason: 'stitching_issue', qtyPcs: 2 }, { reason: 'missing', qtyPcs: 2 }] },
  ]);
  // S1 batches: 96 then 84 (174 pass, 6 reject)
  const c3 = check(HO, 62, STAFF.KAVITA, j1, SIZE.S1, 96, [
    { days: 59, passed: 90, rejected: [{ reason: 'elastic_issue', qtyPcs: 6 }] },
  ]);
  const c4 = check(HO, 60, STAFF.KAVITA, j1, SIZE.S1, 84, [{ days: 57, passed: 84 }]);
  // packing straight from checking — Pooja packs her own checked goods
  pack(HO, 55, STAFF.POOJA, c1, 58, [{ days: 53, packed: 58 }]);
  pack(HO, 55, STAFF.POOJA, c2, 56, [{ days: 53, packed: 56 }]);
  pack(HO, 55, STAFF.KAVITA, c3, 90, [{ days: 52, packed: 84, short: 6, shortReason: 'damage' }]);
  pack(HO, 54, STAFF.KAVITA, c4, 84, [{ days: 52, packed: 84 }]);
  must(
    createDispatch(db, HO, { dispatchDate: daysAgo(45), modelId: modelIdOf('315'), colorId: COLOR.BLACK, sizeId: SIZE.XS, qtyPcs: 96, notes: 'Karol Bagh shop order' }, ADMIN, null),
    'dispatch 1',
  );

  // Month 1 — code 410 satin maroon: excess receipt story
  const p2 = purchase(HO, 75, VENDOR.GUPTA, COLOR.MAROON, 160, 44, 4800);
  cut(HO, 70, p2, [{ sizeId: SIZE.S2, code: '410', qtyPcs: 228, withPhoto: true }]);
  const i2 = issue(HO, 68, CT.RAFIQ, [
    { code: '410', colorId: COLOR.MAROON, sizeId: SIZE.S2, qtyPcs: 228, rate: 2800 },
  ]);
  const j2 = i2.cards[0]!.id;
  receive(HO, 60, j2, [{ lineId: i2.lineId(j2, SIZE.S2), qtyPcs: 120 }]);
  receive(HO, 54, j2, [{ lineId: i2.lineId(j2, SIZE.S2), qtyPcs: 114, discrepancyReason: 'other' }]);
  const c5 = check(HO, 50, STAFF.DEEPA, j2, SIZE.S2, 120, [
    { days: 48, passed: 116, rejected: [{ reason: 'color_defect', qtyPcs: 4 }] },
  ]);
  const c6 = check(HO, 49, STAFF.DEEPA, j2, SIZE.S2, 114, [
    { days: 48, passed: 106, rejected: [{ reason: 'color_defect', qtyPcs: 6 }, { reason: 'missing', qtyPcs: 2 }] },
  ]);
  pack(HO, 46, STAFF.DEEPA, c5, 116, [{ days: 44, packed: 116 }]);
  // THE BUNDLE STORY: the owner asks Deepa to keep 24 pcs aside for a future order…
  pack(HO, 45, STAFF.DEEPA, c6, 24, [], { kind: 'bundle', label: 'Festival order reserve' });
  // …and the rest is packed normally
  pack(HO, 45, STAFF.DEEPA, c6, 82, [{ days: 44, packed: 82 }]);
  must(
    createDispatch(db, HO, { dispatchDate: daysAgo(40), modelId: modelIdOf('410'), colorId: COLOR.MAROON, sizeId: SIZE.S2, qtyPcs: 180, notes: 'Sadar Bazar wholesale' }, ADMIN, null),
    'dispatch 2',
  );

  // Month 2 — code 128 cotton navy: unstitched return + shortage close
  const p3 = purchase(HO, 55, VENDOR.KRISHNA, COLOR.NAVY, 190, 40, 3500);
  cut(HO, 50, p3, [{ sizeId: SIZE.L1, code: '128', qtyPcs: 236 }]);
  const i3 = issue(HO, 48, CT.SUNITA, [
    { code: '128', colorId: COLOR.NAVY, sizeId: SIZE.L1, qtyPcs: 236, rate: 3200 },
  ]);
  const j3 = i3.cards[0]!.id;
  receive(HO, 42, j3, [{ lineId: i3.lineId(j3, SIZE.L1), qtyPcs: 180 }]);
  receive(HO, 38, j3, [{ lineId: i3.lineId(j3, SIZE.L1), qtyPcs: 24, returnType: 'unstitched_return' }]);
  must(
    closeJobWithDiscrepancy(db, HO, j3, { reason: 'missing_pieces', note: 'Sunita could not account for 32 pcs' }, ADMIN, null),
    'close j3 short',
  );
  const c7 = check(HO, 35, STAFF.POOJA, j3, SIZE.L1, 180, [
    { days: 33, passed: 176, rejected: [{ reason: 'damage', qtyPcs: 4 }] },
  ]);
  pack(HO, 30, STAFF.POOJA, c7, 176, [{ days: 28, packed: 176 }]);

  // Month 2 — a COMBINED issue across two codes/colors → separate cards (ADR-033)
  const p4 = purchase(HO, 40, VENDOR.SHARMA, COLOR.EMERALD, 130, 44, 4200);
  cut(HO, 34, p4, [{ sizeId: SIZE.S1, code: '315', qtyPcs: 192 }]);
  const p4b = purchase(HO, 39, VENDOR.GUPTA, COLOR.PINK, 120, 44, 5000, 'satin for 210');
  cut(HO, 33, p4b, [{ sizeId: SIZE.S1, code: '210', qtyPcs: 120, withPhoto: true }]);
  const i4 = issue(HO, 32, CT.MEENA, [
    { code: '315', colorId: COLOR.EMERALD, sizeId: SIZE.S1, qtyPcs: 192, rate: 3000 },
    { code: '210', colorId: COLOR.PINK, sizeId: SIZE.S1, qtyPcs: 96, rate: 3100 },
  ]);
  const j4a = i4.cardFor('315', COLOR.EMERALD).id;
  const j4b = i4.cardFor('210', COLOR.PINK).id;
  receive(HO, 24, j4a, [{ lineId: i4.lineId(j4a, SIZE.S1), qtyPcs: 192 }]);
  receive(HO, 23, j4b, [{ lineId: i4.lineId(j4b, SIZE.S1), qtyPcs: 48 }]);
  const c8 = check(HO, 20, STAFF.DEEPA, j4a, SIZE.S1, 192, [{ days: 18, passed: 120 }]);
  // Deepa still holds 72 unchecked; her 120 passed are not yet allotted to packing —
  // the checking page shows the "Pack" button live on this row
  void c8;

  // Month 3 — code 522 organza lavender: received but nobody has checked yet
  const p5 = purchase(HO, 25, VENDOR.GUPTA, COLOR.LAVENDER, 95, 44, 5600, 'festival order fabric');
  cut(HO, 20, p5, [
    { sizeId: SIZE.XL, code: '522', qtyPcs: 132, withPhoto: true },
    { sizeId: SIZE.L1, code: '522', qtyPcs: 44 },
  ]);
  const i5 = issue(HO, 18, CT.FARAH, [
    { code: '522', colorId: COLOR.LAVENDER, sizeId: SIZE.XL, qtyPcs: 132, rate: 2900 },
  ]);
  const j5 = i5.cards[0]!.id;
  receive(HO, 10, j5, [{ lineId: i5.lineId(j5, SIZE.XL), qtyPcs: 60 }]);

  // a DELAYED job for the alert panel: issued 24 days ago, nothing back yet
  const p6 = purchase(HO, 30, VENDOR.KRISHNA, COLOR.MUSTARD, 110, 40, 3600);
  cut(HO, 27, p6, [{ sizeId: SIZE.S2, code: '128', qtyPcs: 168 }]);
  issue(HO, 24, CT.RAFIQ, [{ code: '128', colorId: COLOR.MUSTARD, sizeId: SIZE.S2, qtyPcs: 168, rate: 2800 }]);

  // fresh activity this week: new purchases + a cutting that can still be edited/deleted
  const p7 = purchase(HO, 4, VENDOR.SHARMA, COLOR.PINK, 170, 44, 5000, 'summer collection');
  cut(HO, 1, p7, [
    { sizeId: SIZE.XS, code: '410', qtyPcs: 120 },
    { sizeId: SIZE.S1, code: '410', qtyPcs: 144 },
  ]);
  purchase(HO, 2, VENDOR.GUPTA, COLOR.WHITE, 150, 44, 4300, 'wedding season stock');

  // a voided purchase (typo demo — appears in audit + voided list)
  const pOops = purchase(HO, 15, VENDOR.KRISHNA, COLOR.WHITE, 500, 44, 5600, 'typo: was meant to be 50 yd');
  must(voidPurchase(db, HO, pOops, 'entered 500 yd instead of 50 yd', ADMIN, null), 'void pOops');
  purchase(HO, 15, VENDOR.KRISHNA, COLOR.WHITE, 50, 44, 5600, 're-entered correctly');

  // payments: Meena mostly settled, others carry dues (the Dues page has data)
  must(createPayment(db, HO, { contractorId: CT.MEENA, paymentDate: daysAgo(50), amountPaise: 50000, mode: 'upi', reference: 'UPI-4471', notes: '' }, OPERATOR, null), 'pay1');
  must(createPayment(db, HO, { contractorId: CT.MEENA, paymentDate: daysAgo(12), amountPaise: 20000, mode: 'cash', reference: '', notes: 'advance adjusted' }, OPERATOR, null), 'pay2');
  must(createPayment(db, HO, { contractorId: CT.RAFIQ, paymentDate: daysAgo(30), amountPaise: 30000, mode: 'bank_transfer', reference: 'NEFT-88123', notes: '' }, OPERATOR, null), 'pay3');
  must(createPayment(db, HO, { contractorId: CT.SUNITA, paymentDate: daysAgo(20), amountPaise: 25000, mode: 'cash', reference: '', notes: '' }, OPERATOR, null), 'pay4');

  // ---- BRANCH OFFICE: a small, separate operation (BR- document numbers) -----
  const bp1 = purchase(BR, 12, VENDOR.GUPTA, COLOR.BLACK, 80, 44, 4200, 'branch stock');
  cut(BR, 8, bp1, [{ sizeId: SIZE.S1, code: 'B-101', qtyPcs: 96, withPhoto: true }]);
  const bi1 = issue(BR, 6, CT.FARAH, [
    { code: 'B-101', colorId: COLOR.BLACK, sizeId: SIZE.S1, qtyPcs: 96, rate: 2900 },
  ]);
  const bj1 = bi1.cards[0]!.id;
  receive(BR, 2, bj1, [{ lineId: bi1.lineId(bj1, SIZE.S1), qtyPcs: 48 }]);
  purchase(BR, 3, VENDOR.SHARMA, COLOR.NAVY, 60, 40, 3900);

  // resolve the two oldest discrepancies so a demo shows both review states
  const toResolve = db
    .prepare('SELECT id FROM discrepancies ORDER BY created_at ASC, id ASC LIMIT 2')
    .all() as Array<{ id: number }>;
  const notes = ['counting error at the cutting table — register corrected', 'settled with contractor against dues'];
  toResolve.forEach((d, i) => must(resolveDiscrepancy(db, d.id, notes[i]!, ADMIN, null), `resolve d${d.id}`));

  return runReconciliation(db);
}
