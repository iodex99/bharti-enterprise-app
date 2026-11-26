import type { DispatchInput, PackIssueEditInput, PackIssueInput, PackResultInput } from '@shared';
import type { Db } from '../db/connection';
import { nowIso } from '../db/connection';
import { audit } from './audit.service';
import { staffDefaultRate, staffUsable } from './checking.service';
import { nextDocNo } from './docNo.service';
import {
  availableLots,
  LedgerError,
  postMovements,
  splitFifo,
  type Movement,
} from './ledger.service';
import type { Office } from './offices.service';
import type { ServiceResult } from './purchases.service';

/**
 * Module 5: packing + bundles + finished goods + minimal dispatch (v2, ADR-035).
 * There is no separate packing module: packing is ALLOTTED FROM THE CHECKING PAGE,
 * directed at a specific source lot — a checker's passed goods (usually packed by the
 * same person), an opening lot, or a BUNDLE.
 *
 * A bundle (kind='bundle') is checked goods the owner asked to keep aside, labeled, to
 * be packed later — it holds its pieces in the PACKING stage until used.
 *
 * Ledger: allot   PACKING −(source lot) → PACKING +(lot=pack_issue, staff=packer).
 *         result  packed → FG (lot=pack_issue); short → terminal + discrepancy.
 *         dispatch (admin): FG FIFO → terminal 'dispatch'; void replays the rows back.
 */

type PackSource = {
  modelId: number;
  colorId: number;
  sizeId: number;
  available: number;
  /** staff currently holding the source lot (bundles); null for pool lots */
  holderStaffId: number | null;
  label: string;
};

function packSourceInfo(
  db: Db,
  office: Office,
  lotType: 'check_issue' | 'opening' | 'pack_issue',
  lotId: number,
): PackSource | null {
  if (lotType === 'check_issue') {
    const ci = db
      .prepare(
        `SELECT doc_no, model_id, color_id, size_id FROM check_issues
         WHERE id = ? AND office_id = ? AND voided_at IS NULL`,
      )
      .get(lotId, office.id) as
      { doc_no: string; model_id: number; color_id: number; size_id: number } | undefined;
    if (!ci) return null;
    const bal = (
      db
        .prepare(
          `SELECT COALESCE(SUM(qty),0) AS bal FROM stock_ledger
           WHERE stage='PACKING' AND office_id = ? AND staff_id IS NULL AND lot_type='check_issue' AND lot_id = ?`,
        )
        .get(office.id, lotId) as { bal: number }
    ).bal;
    return {
      modelId: ci.model_id,
      colorId: ci.color_id,
      sizeId: ci.size_id,
      available: bal,
      holderStaffId: null,
      label: ci.doc_no,
    };
  }
  if (lotType === 'opening') {
    const o = db
      .prepare(
        `SELECT doc_no, model_id, color_id, size_id FROM opening_balances
         WHERE id = ? AND office_id = ? AND stage = 'PACKING' AND voided_at IS NULL`,
      )
      .get(lotId, office.id) as
      { doc_no: string; model_id: number; color_id: number; size_id: number } | undefined;
    if (!o) return null;
    const bal = (
      db
        .prepare(
          `SELECT COALESCE(SUM(qty),0) AS bal FROM stock_ledger
           WHERE stage='PACKING' AND office_id = ? AND staff_id IS NULL AND lot_type='opening' AND lot_id = ?`,
        )
        .get(office.id, lotId) as { bal: number }
    ).bal;
    return {
      modelId: o.model_id,
      colorId: o.color_id,
      sizeId: o.size_id,
      available: bal,
      holderStaffId: null,
      label: o.doc_no,
    };
  }
  // pack_issue source = an existing BUNDLE being used for packing
  const bundle = db
    .prepare(
      `SELECT doc_no, model_id, color_id, size_id, staff_id, kind FROM pack_issues
       WHERE id = ? AND office_id = ? AND voided_at IS NULL`,
    )
    .get(lotId, office.id) as
    | {
        doc_no: string;
        model_id: number;
        color_id: number;
        size_id: number;
        staff_id: number;
        kind: string;
      }
    | undefined;
  if (!bundle || bundle.kind !== 'bundle') return null;
  const bal = (
    db
      .prepare(
        `SELECT COALESCE(SUM(qty),0) AS bal FROM stock_ledger
         WHERE stage='PACKING' AND office_id = ? AND lot_type='pack_issue' AND lot_id = ?`,
      )
      .get(office.id, lotId) as { bal: number }
  ).bal;
  return {
    modelId: bundle.model_id,
    colorId: bundle.color_id,
    sizeId: bundle.size_id,
    available: bal,
    holderStaffId: bundle.staff_id,
    label: bundle.doc_no,
  };
}

/**
 * Where a pack issue's pieces came from, NET of any edits: every PACKING row this issue
 * posted against a lot other than its own. Edits post a reversal plus a fresh take, so
 * only the net tells the truth.
 */
function packConsumption(
  db: Db,
  packIssueId: number,
): Array<{
  lot_type: 'check_issue' | 'opening' | 'pack_issue';
  lot_id: number;
  staff_id: number | null;
  qty: number;
}> {
  return db
    .prepare(
      `SELECT lot_type, lot_id, MAX(staff_id) AS staff_id, -SUM(qty) AS qty FROM stock_ledger
       WHERE stage = 'PACKING' AND ref_type IN ('pack_issue', 'void_reversal') AND ref_id = ?
         AND NOT (lot_type = 'pack_issue' AND lot_id = ?)
       GROUP BY lot_type, lot_id
       HAVING SUM(qty) < 0`,
    )
    .all(packIssueId, packIssueId) as Array<{
    lot_type: 'check_issue' | 'opening' | 'pack_issue';
    lot_id: number;
    staff_id: number | null;
    qty: number;
  }>;
}

/** Record which check issues/opening lots a pack issue's pieces trace back to. */
function writePackAllocations(
  db: Db,
  packIssueId: number,
  lotType: 'check_issue' | 'opening' | 'pack_issue',
  lotId: number,
  qtyPcs: number,
): void {
  const insertAlloc = db.prepare(
    `INSERT INTO pack_allocations (pack_issue_id, packing_lot_type, packing_lot_id, qty_pcs)
     VALUES (?, ?, ?, ?)`,
  );
  if (lotType === 'pack_issue') {
    const bundleAllocs = db
      .prepare(
        `SELECT packing_lot_type, packing_lot_id, qty_pcs FROM pack_allocations
         WHERE pack_issue_id = ? ORDER BY id`,
      )
      .all(lotId) as Array<{
      packing_lot_type: 'check_issue' | 'opening';
      packing_lot_id: number;
      qty_pcs: number;
    }>;
    const takes = splitFifo(
      bundleAllocs.map((a) => ({
        lotType: a.packing_lot_type,
        lotId: a.packing_lot_id,
        qty: a.qty_pcs,
      })),
      qtyPcs,
    );
    for (const take of takes) insertAlloc.run(packIssueId, take.lotType, take.lotId, take.qty);
  } else {
    insertAlloc.run(packIssueId, lotType, lotId, qtyPcs);
  }
}

/** A bundle that got pieces back is holding stock again — reopen it if it was emptied. */
function reopenBundleIfHolding(db: Db, bundleId: number): void {
  const held = (
    db
      .prepare(
        `SELECT COALESCE(SUM(qty),0) AS bal FROM stock_ledger
         WHERE stage='PACKING' AND lot_type='pack_issue' AND lot_id = ?`,
      )
      .get(bundleId) as { bal: number }
  ).bal;
  if (held > 0) {
    db.prepare(
      "UPDATE pack_issues SET status = 'open', completed_at = NULL WHERE id = ? AND status = 'completed'",
    ).run(bundleId);
  }
}

/**
 * Allot packing (or keep a bundle aside) from a specific source lot. Directed, like
 * checking — the checker↔packer mapping is explicit, and the default packer in the UI
 * is the person who checked the goods.
 */
export function createPackIssue(
  db: Db,
  office: Office,
  input: PackIssueInput,
  userId: number,
  ip: string | null,
  onCreated?: (id: number) => void,
): ServiceResult<{ id: number; docNo: string }> {
  const staffError = staffUsable(db, input.staffId, 'Packer');
  if (staffError) return { ok: false, code: 400, error: staffError };
  const source = packSourceInfo(db, office, input.lotType, input.lotId);
  if (!source) return { ok: false, code: 400, error: 'That source batch was not found.' };
  if (source.available < input.qtyPcs) {
    return {
      ok: false,
      code: 409,
      error: `${source.label} has only ${source.available} pcs available.`,
    };
  }
  if (input.kind === 'bundle' && !input.label) {
    return { ok: false, code: 400, error: 'Give the bundle a name so it can be found later.' };
  }

  let id = 0;
  let docNo = '';
  try {
    const tx = db.transaction(() => {
      docNo = nextDocNo(db, 'pack', office);
      // the packer's pay per dozen is snapshotted here, like contractor rates on jobs
      const rate = input.ratePaisePerDozen ?? staffDefaultRate(db, input.staffId);
      const info = db
        .prepare(
          `INSERT INTO pack_issues (doc_no, office_id, issue_date, staff_id, model_id, color_id, size_id,
            qty_pcs, kind, label, rate_paise_per_dozen, notes, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          docNo,
          office.id,
          input.issueDate,
          input.staffId,
          source.modelId,
          source.colorId,
          source.sizeId,
          input.qtyPcs,
          input.kind,
          input.label,
          rate,
          input.notes,
          userId,
        );
      id = Number(info.lastInsertRowid);

      // Allocations keep the FG→checker→contractor trace intact. A bundle source is a
      // pack_issue (not allowed in pack_allocations by the v1 CHECK), so its ORIGINAL
      // allocations are carried forward instead — the trace passes through the bundle.
      writePackAllocations(db, id, input.lotType, input.lotId, input.qtyPcs);

      const base = {
        officeId: office.id,
        modelId: source.modelId,
        colorId: source.colorId,
        sizeId: source.sizeId,
      };
      postMovements(
        db,
        [
          {
            ...base,
            stage: 'PACKING',
            staffId: source.holderStaffId,
            lotType: input.lotType,
            lotId: input.lotId,
            qty: -input.qtyPcs,
            refType: 'pack_issue',
            refId: id,
          },
          {
            ...base,
            stage: 'PACKING',
            staffId: input.staffId,
            lotType: 'pack_issue',
            lotId: id,
            qty: input.qtyPcs,
            refType: 'pack_issue',
            refId: id,
          },
        ],
        userId,
      );
      audit(db, {
        userId,
        action: 'create',
        entityType: 'pack_issue',
        entityId: id,
        new: { docNo, officeId: office.id, ...input },
        ip,
      });
      onCreated?.(id);
    });
    tx();
  } catch (err) {
    if (err instanceof LedgerError) return { ok: false, code: 409, error: err.message };
    throw err;
  }
  return { ok: true, id, docNo };
}

export function recordPackResult(
  db: Db,
  office: Office,
  packIssueId: number,
  input: PackResultInput,
  userId: number,
  ip: string | null,
): ServiceResult<{ id: number; status: string }> {
  const issue = db
    .prepare('SELECT * FROM pack_issues WHERE id = ? AND office_id = ? AND voided_at IS NULL')
    .get(packIssueId, office.id) as Record<string, unknown> | undefined;
  if (!issue) return { ok: false, code: 404, error: 'Packing issue not found.' };
  if (issue.status === 'completed') {
    return { ok: false, code: 409, error: 'This packing issue is already completed.' };
  }

  // A bundle's pieces may have been moved to another packing — results only cover what
  // the holder still physically has.
  const held = (
    db
      .prepare(
        `SELECT COALESCE(SUM(qty),0) AS bal FROM stock_ledger
         WHERE stage='PACKING' AND lot_type='pack_issue' AND lot_id = ?`,
      )
      .get(packIssueId) as { bal: number }
  ).bal;
  const sessionTotal = input.qtyPacked + input.qtyShort;
  if (sessionTotal > held) {
    return {
      ok: false,
      code: 409,
      error: `This session covers ${sessionTotal} pcs but only ${held} pcs are with the packer.`,
    };
  }

  let resultId = 0;
  let status = 'open';
  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO pack_results (pack_issue_id, result_date, qty_packed, qty_short, short_reason, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        packIssueId,
        input.resultDate,
        input.qtyPacked,
        input.qtyShort,
        input.shortReason ?? null,
        input.notes,
        userId,
      );
    resultId = Number(info.lastInsertRowid);

    const base = {
      officeId: office.id,
      modelId: issue.model_id as number,
      colorId: issue.color_id as number,
      sizeId: issue.size_id as number,
    };
    const movements: Movement[] = [];
    if (input.qtyPacked > 0) {
      movements.push(
        {
          ...base,
          stage: 'PACKING',
          staffId: issue.staff_id as number,
          lotType: 'pack_issue',
          lotId: packIssueId,
          qty: -input.qtyPacked,
          refType: 'pack_output',
          refId: resultId,
        },
        {
          ...base,
          stage: 'FG',
          lotType: 'pack_issue',
          lotId: packIssueId,
          qty: input.qtyPacked,
          refType: 'pack_output',
          refId: resultId,
        },
      );
    }
    if (input.qtyShort > 0) {
      movements.push({
        ...base,
        stage: 'PACKING',
        staffId: issue.staff_id as number,
        lotType: 'pack_issue',
        lotId: packIssueId,
        qty: -input.qtyShort,
        refType: 'pack_short',
        refId: resultId,
      });
      db.prepare(
        `INSERT INTO discrepancies (stage, office_id, ref_type, ref_id, qty_pcs, reason, note, created_by)
         VALUES ('PACKING', ?, 'pack_result', ?, ?, ?, ?, ?)`,
      ).run(office.id, resultId, -input.qtyShort, input.shortReason, input.notes, userId);
    }
    postMovements(db, movements, userId);

    if (sessionTotal === held) {
      db.prepare("UPDATE pack_issues SET status = 'completed', completed_at = ? WHERE id = ?").run(
        nowIso(),
        packIssueId,
      );
      status = 'completed';
    }
    audit(db, {
      userId,
      action: 'record_result',
      entityType: 'pack_issue',
      entityId: packIssueId,
      new: input,
      ip,
    });
  });
  tx();
  return { ok: true, id: resultId, status };
}

export function voidPackIssue(
  db: Db,
  office: Office,
  packIssueId: number,
  reason: string,
  userId: number,
  ip: string | null,
): ServiceResult {
  const issue = db
    .prepare('SELECT * FROM pack_issues WHERE id = ? AND office_id = ?')
    .get(packIssueId, office.id) as Record<string, unknown> | undefined;
  if (!issue) return { ok: false, code: 404, error: 'Packing issue not found.' };
  if (issue.voided_at) return { ok: false, code: 409, error: 'Already voided.' };
  const results = (
    db
      .prepare('SELECT COUNT(*) AS n FROM pack_results WHERE pack_issue_id = ?')
      .get(packIssueId) as { n: number }
  ).n;
  if (results > 0) {
    return { ok: false, code: 409, error: 'Cannot void: packing results exist for this issue.' };
  }

  // What the issue drew from is in its own ledger rows — works for pool AND bundle
  // sources, and stays right after an edit (net of the edit's reversal + re-take).
  const consumed = packConsumption(db, packIssueId);

  const base = {
    officeId: office.id,
    modelId: issue.model_id as number,
    colorId: issue.color_id as number,
    sizeId: issue.size_id as number,
  };
  const tx = db.transaction(() => {
    postMovements(
      db,
      [
        {
          ...base,
          stage: 'PACKING',
          staffId: issue.staff_id as number,
          lotType: 'pack_issue',
          lotId: packIssueId,
          qty: -(issue.qty_pcs as number),
          refType: 'void_reversal',
          refId: packIssueId,
        },
        ...consumed.map((c) => ({
          ...base,
          stage: 'PACKING' as const,
          staffId: c.staff_id,
          lotType: c.lot_type as never,
          lotId: c.lot_id,
          qty: c.qty,
          refType: 'void_reversal' as const,
          refId: packIssueId,
        })),
      ],
      userId,
    );
    db.prepare(
      'UPDATE pack_issues SET voided_at = ?, void_reason = ?, voided_by = ? WHERE id = ?',
    ).run(nowIso(), reason, userId, packIssueId);
    // Pieces just flowed back onto their source. If that source was a BUNDLE which had
    // been marked completed when it was emptied, it is holding stock again — reopen it,
    // or those pieces could never be packed from the bundle again.
    for (const c of consumed) {
      if (c.lot_type === 'pack_issue') reopenBundleIfHolding(db, c.lot_id);
    }
    audit(db, {
      userId,
      action: 'void',
      entityType: 'pack_issue',
      entityId: packIssueId,
      new: { reason },
      ip,
    });
  });
  tx();
  return { ok: true, id: packIssueId };
}

/**
 * Edit a pack issue (or bundle). Before any packing result: packer, quantity, label,
 * rate, date, notes — the pieces go back to their source and are taken again. After
 * results only the date, label, rate and notes can change (pay re-prices from the rate).
 */
export function editPackIssue(
  db: Db,
  office: Office,
  packIssueId: number,
  input: PackIssueEditInput,
  userId: number,
  ip: string | null,
): ServiceResult {
  const issue = db
    .prepare('SELECT * FROM pack_issues WHERE id = ? AND office_id = ? AND voided_at IS NULL')
    .get(packIssueId, office.id) as Record<string, unknown> | undefined;
  if (!issue) return { ok: false, code: 404, error: 'Packing not found.' };
  const results = (
    db
      .prepare('SELECT COUNT(*) AS n FROM pack_results WHERE pack_issue_id = ?')
      .get(packIssueId) as { n: number }
  ).n;
  const reissue = input.staffId !== issue.staff_id || input.qtyPcs !== issue.qty_pcs;
  if (reissue && results > 0) {
    return {
      ok: false,
      code: 409,
      error:
        'Packing is already recorded for this work, so the packer and quantity are fixed. You can still change the date, rate, name and notes.',
    };
  }
  if (issue.kind === 'bundle' && !input.label) {
    return { ok: false, code: 400, error: 'Give the bundle a name so it can be found later.' };
  }
  if (reissue) {
    // a bundle whose pieces were already moved on can't simply shrink or change hands
    const used = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM stock_ledger
           WHERE stage = 'PACKING' AND lot_type = 'pack_issue' AND lot_id = ? AND ref_id != ? AND qty < 0`,
        )
        .get(packIssueId, packIssueId) as { n: number }
    ).n;
    if (used > 0) {
      return {
        ok: false,
        code: 409,
        error:
          'Some of these pieces were already packed from this bundle, so the packer and quantity are fixed.',
      };
    }
    if (input.staffId !== issue.staff_id) {
      const staffError = staffUsable(db, input.staffId, 'Packer');
      if (staffError) return { ok: false, code: 400, error: staffError };
    }
  }

  try {
    const tx = db.transaction(() => {
      if (reissue) {
        const [src] = packConsumption(db, packIssueId);
        if (!src) throw new LedgerError('The source of this packing could not be found.');
        const base = {
          officeId: office.id,
          modelId: issue.model_id as number,
          colorId: issue.color_id as number,
          sizeId: issue.size_id as number,
        };
        postMovements(
          db,
          [
            {
              ...base,
              stage: 'PACKING',
              staffId: issue.staff_id as number,
              lotType: 'pack_issue',
              lotId: packIssueId,
              qty: -(issue.qty_pcs as number),
              refType: 'void_reversal',
              refId: packIssueId,
            },
            {
              ...base,
              stage: 'PACKING',
              staffId: src.staff_id,
              lotType: src.lot_type,
              lotId: src.lot_id,
              qty: src.qty,
              refType: 'void_reversal',
              refId: packIssueId,
            },
          ],
          userId,
        );
        postMovements(
          db,
          [
            {
              ...base,
              stage: 'PACKING',
              staffId: src.staff_id,
              lotType: src.lot_type,
              lotId: src.lot_id,
              qty: -input.qtyPcs,
              refType: 'pack_issue',
              refId: packIssueId,
            },
            {
              ...base,
              stage: 'PACKING',
              staffId: input.staffId,
              lotType: 'pack_issue',
              lotId: packIssueId,
              qty: input.qtyPcs,
              refType: 'pack_issue',
              refId: packIssueId,
            },
          ],
          userId,
        );
        db.prepare('DELETE FROM pack_allocations WHERE pack_issue_id = ?').run(packIssueId);
        writePackAllocations(db, packIssueId, src.lot_type, src.lot_id, input.qtyPcs);
        if (src.lot_type === 'pack_issue') reopenBundleIfHolding(db, src.lot_id);
      }
      db.prepare(
        `UPDATE pack_issues SET issue_date = ?, staff_id = ?, qty_pcs = ?, label = ?, rate_paise_per_dozen = ?, notes = ?
         WHERE id = ?`,
      ).run(
        input.issueDate,
        input.staffId,
        input.qtyPcs,
        input.label,
        input.ratePaisePerDozen,
        input.notes,
        packIssueId,
      );
      audit(db, {
        userId,
        action: 'update',
        entityType: 'pack_issue',
        entityId: packIssueId,
        old: {
          issueDate: issue.issue_date,
          staffId: issue.staff_id,
          qtyPcs: issue.qty_pcs,
          label: issue.label,
          ratePaisePerDozen: issue.rate_paise_per_dozen,
          notes: issue.notes,
        },
        new: input,
        ip,
      });
    });
    tx();
  } catch (err) {
    if (err instanceof LedgerError) return { ok: false, code: 409, error: err.message };
    throw err;
  }
  return { ok: true, id: packIssueId };
}

/**
 * Packed goods — every packing session that produced finished goods, newest first.
 * This is the "what was packed, by whom, when" register the checking list never showed.
 */
export function listPacked(db: Db, officeId: number): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT pr.id, pr.result_date AS packedDate, pr.qty_packed AS packedPcs, pr.qty_short AS shortPcs,
              pr.short_reason AS shortReason, pr.notes,
              pi.id AS packIssueId, pi.doc_no AS docNo, pi.kind, pi.label,
              pi.rate_paise_per_dozen AS ratePaisePerDozen,
              st.name AS staffName, m.code AS code, m.image_path AS codeImagePath,
              m.code || '-' || s.code AS sizeCodeLabel, c.name AS colorName, s.code AS sizeCode,
              ci.doc_no AS checkDocNo, ct.name AS contractorName
       FROM pack_results pr
       JOIN pack_issues pi ON pi.id = pr.pack_issue_id AND pi.voided_at IS NULL AND pi.office_id = ?
       JOIN staff st ON st.id = pi.staff_id
       JOIN models m ON m.id = pi.model_id
       JOIN colors c ON c.id = pi.color_id
       JOIN sizes s ON s.id = pi.size_id
       LEFT JOIN pack_allocations pa ON pa.id =
         (SELECT MIN(pa2.id) FROM pack_allocations pa2
          WHERE pa2.pack_issue_id = pi.id AND pa2.packing_lot_type = 'check_issue')
       LEFT JOIN check_issues ci ON ci.id = pa.packing_lot_id
       LEFT JOIN check_allocations ca ON ca.id =
         (SELECT MIN(ca2.id) FROM check_allocations ca2
          WHERE ca2.check_issue_id = ci.id AND ca2.checking_lot_type = 'receipt_line')
       LEFT JOIN job_receipt_lines rl ON rl.id = ca.checking_lot_id
       LEFT JOIN job_receipts r ON r.id = rl.job_receipt_id
       LEFT JOIN job_cards jc ON jc.id = r.job_card_id
       LEFT JOIN contractors ct ON ct.id = jc.contractor_id
       WHERE pr.qty_packed > 0 OR pr.qty_short > 0
       ORDER BY pr.result_date DESC, pr.id DESC`,
    )
    .all(officeId) as Array<Record<string, unknown>>;
}

export function listPackIssues(
  db: Db,
  officeId: number,
  opts: { kind?: 'pack' | 'bundle' } = {},
): Array<Record<string, unknown>> {
  const where: string[] = ['pi.voided_at IS NULL', 'pi.office_id = ?'];
  const params: unknown[] = [officeId];
  if (opts.kind) {
    where.push('pi.kind = ?');
    params.push(opts.kind);
  }
  const issues = db
    .prepare(
      `SELECT pi.id, pi.doc_no AS docNo, pi.issue_date AS issueDate, pi.status, pi.notes,
              pi.qty_pcs AS qtyPcs, pi.kind, pi.label, pi.rate_paise_per_dozen AS ratePaisePerDozen,
              pi.voided_at AS voidedAt,
              pi.staff_id AS staffId, st.name AS staffName,
              pi.model_id AS modelId, m.code AS code, m.image_path AS codeImagePath,
              m.code || '-' || s.code AS sizeCodeLabel,
              pi.color_id AS colorId, c.name AS colorName,
              pi.size_id AS sizeId, s.code AS sizeCode
       FROM pack_issues pi
       JOIN staff st ON st.id = pi.staff_id
       JOIN models m ON m.id = pi.model_id
       JOIN colors c ON c.id = pi.color_id
       JOIN sizes s ON s.id = pi.size_id
       WHERE ${where.join(' AND ')}
       ORDER BY pi.id DESC`,
    )
    .all(...params) as Array<Record<string, unknown>>;
  const resultsStmt = db.prepare(
    `SELECT id, result_date AS resultDate, qty_packed AS qtyPacked, qty_short AS qtyShort,
            short_reason AS shortReason, notes
     FROM pack_results WHERE pack_issue_id = ? ORDER BY id`,
  );
  const heldStmt = db.prepare(
    `SELECT COALESCE(SUM(qty),0) AS bal FROM stock_ledger
     WHERE stage='PACKING' AND lot_type='pack_issue' AND lot_id = ?`,
  );
  for (const issue of issues) {
    const results = resultsStmt.all(issue.id) as Array<Record<string, unknown>>;
    issue.results = results;
    issue.packedPcs = results.reduce((s, r) => s + (r.qtyPacked as number), 0);
    issue.shortPcs = results.reduce((s, r) => s + (r.qtyShort as number), 0);
    issue.heldPcs = (heldStmt.get(issue.id) as { bal: number }).bal;
  }
  return issues;
}

// ---------------------------------------------------------------------------
// dispatch (minimal FG stock-out — the full sales module lives on the roadmap)
// ---------------------------------------------------------------------------

export function createDispatch(
  db: Db,
  office: Office,
  input: DispatchInput,
  userId: number,
  ip: string | null,
  onCreated?: (id: number) => void,
): ServiceResult<{ id: number; docNo: string }> {
  let id = 0;
  let docNo = '';
  try {
    const tx = db.transaction(() => {
      docNo = nextDocNo(db, 'dispatch', office);
      const info = db
        .prepare(
          `INSERT INTO fg_dispatches (doc_no, office_id, dispatch_date, model_id, color_id, size_id, qty_pcs, notes, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          docNo,
          office.id,
          input.dispatchDate,
          input.modelId,
          input.colorId,
          input.sizeId,
          input.qtyPcs,
          input.notes,
          userId,
        );
      id = Number(info.lastInsertRowid);

      const lots = availableLots(db, {
        stage: 'FG',
        officeId: office.id,
        modelId: input.modelId,
        colorId: input.colorId,
        sizeId: input.sizeId,
      });
      const totalAvailable = lots.reduce((s, l) => s + l.qty, 0);
      if (totalAvailable < input.qtyPcs) {
        throw new LedgerError(
          `Not enough finished goods: needed ${input.qtyPcs} pcs, available ${totalAvailable} pcs.`,
        );
      }
      const takes = splitFifo(lots, input.qtyPcs);
      postMovements(
        db,
        takes.map((take) => ({
          stage: 'FG' as const,
          officeId: office.id,
          modelId: input.modelId,
          colorId: input.colorId,
          sizeId: input.sizeId,
          lotType: take.lotType,
          lotId: take.lotId,
          qty: -take.qty,
          refType: 'dispatch' as const,
          refId: id,
        })),
        userId,
      );
      audit(db, {
        userId,
        action: 'create',
        entityType: 'fg_dispatch',
        entityId: id,
        new: { docNo, officeId: office.id, ...input },
        ip,
      });
      onCreated?.(id);
    });
    tx();
  } catch (err) {
    if (err instanceof LedgerError) return { ok: false, code: 409, error: err.message };
    throw err;
  }
  return { ok: true, id, docNo };
}

export function voidDispatch(
  db: Db,
  office: Office,
  id: number,
  reason: string,
  userId: number,
  ip: string | null,
): ServiceResult {
  const dispatch = db
    .prepare('SELECT * FROM fg_dispatches WHERE id = ? AND office_id = ?')
    .get(id, office.id) as Record<string, unknown> | undefined;
  if (!dispatch) return { ok: false, code: 404, error: 'Dispatch not found.' };
  if (dispatch.voided_at) return { ok: false, code: 409, error: 'Already voided.' };

  // the ledger rows themselves record which FG lots were consumed — net of any edits
  // (an edit puts the old take back with adjustment_in rows, then takes again)
  const consumed = db
    .prepare(
      `SELECT lot_type, lot_id, -SUM(qty) AS qty FROM stock_ledger
       WHERE stage = 'FG' AND ref_type IN ('dispatch', 'adjustment_in') AND ref_id = ?
       GROUP BY lot_type, lot_id HAVING SUM(qty) < 0`,
    )
    .all(id) as Array<{ lot_type: string; lot_id: number; qty: number }>;

  const tx = db.transaction(() => {
    postMovements(
      db,
      consumed.map((c) => ({
        stage: 'FG' as const,
        officeId: office.id,
        modelId: dispatch.model_id as number,
        colorId: dispatch.color_id as number,
        sizeId: dispatch.size_id as number,
        lotType: c.lot_type as never,
        lotId: c.lot_id,
        qty: c.qty,
        refType: 'adjustment_in' as const,
        refId: id,
      })),
      userId,
    );
    db.prepare(
      'UPDATE fg_dispatches SET voided_at = ?, void_reason = ?, voided_by = ? WHERE id = ?',
    ).run(nowIso(), reason, userId, id);
    audit(db, {
      userId,
      action: 'void',
      entityType: 'fg_dispatch',
      entityId: id,
      new: { reason },
      ip,
    });
  });
  tx();
  return { ok: true, id };
}

/**
 * Edit a dispatch (admin): the finished goods it took go back onto the lots they came
 * from, and the corrected dispatch takes again FIFO — one transaction, doc number kept.
 */
export function editDispatch(
  db: Db,
  office: Office,
  id: number,
  input: DispatchInput,
  userId: number,
  ip: string | null,
): ServiceResult {
  const dispatch = db
    .prepare('SELECT * FROM fg_dispatches WHERE id = ? AND office_id = ? AND voided_at IS NULL')
    .get(id, office.id) as Record<string, unknown> | undefined;
  if (!dispatch) return { ok: false, code: 404, error: 'Dispatch not found.' };

  const consumed = db
    .prepare(
      `SELECT lot_type, lot_id, -SUM(qty) AS qty FROM stock_ledger
       WHERE stage = 'FG' AND ref_type IN ('dispatch', 'adjustment_in') AND ref_id = ?
       GROUP BY lot_type, lot_id HAVING SUM(qty) < 0`,
    )
    .all(id) as Array<{ lot_type: string; lot_id: number; qty: number }>;

  try {
    const tx = db.transaction(() => {
      if (consumed.length > 0) {
        postMovements(
          db,
          consumed.map((c) => ({
            stage: 'FG' as const,
            officeId: office.id,
            modelId: dispatch.model_id as number,
            colorId: dispatch.color_id as number,
            sizeId: dispatch.size_id as number,
            lotType: c.lot_type as never,
            lotId: c.lot_id,
            qty: c.qty,
            refType: 'adjustment_in' as const,
            refId: id,
          })),
          userId,
        );
      }
      const lots = availableLots(db, {
        stage: 'FG',
        officeId: office.id,
        modelId: input.modelId,
        colorId: input.colorId,
        sizeId: input.sizeId,
      });
      const totalAvailable = lots.reduce((s, l) => s + l.qty, 0);
      if (totalAvailable < input.qtyPcs) {
        throw new LedgerError(
          `Not enough finished goods: needed ${input.qtyPcs} pcs, available ${totalAvailable} pcs.`,
        );
      }
      postMovements(
        db,
        splitFifo(lots, input.qtyPcs).map((take) => ({
          stage: 'FG' as const,
          officeId: office.id,
          modelId: input.modelId,
          colorId: input.colorId,
          sizeId: input.sizeId,
          lotType: take.lotType,
          lotId: take.lotId,
          qty: -take.qty,
          refType: 'dispatch' as const,
          refId: id,
        })),
        userId,
      );
      db.prepare(
        `UPDATE fg_dispatches SET dispatch_date = ?, model_id = ?, color_id = ?, size_id = ?, qty_pcs = ?, notes = ?
         WHERE id = ?`,
      ).run(
        input.dispatchDate,
        input.modelId,
        input.colorId,
        input.sizeId,
        input.qtyPcs,
        input.notes,
        id,
      );
      audit(db, {
        userId,
        action: 'update',
        entityType: 'fg_dispatch',
        entityId: id,
        old: {
          dispatchDate: dispatch.dispatch_date,
          modelId: dispatch.model_id,
          colorId: dispatch.color_id,
          sizeId: dispatch.size_id,
          qtyPcs: dispatch.qty_pcs,
          notes: dispatch.notes,
        },
        new: input,
        ip,
      });
    });
    tx();
  } catch (err) {
    if (err instanceof LedgerError) return { ok: false, code: 409, error: err.message };
    throw err;
  }
  return { ok: true, id };
}

export function listDispatches(db: Db, officeId: number): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT d.id, d.doc_no AS docNo, d.dispatch_date AS dispatchDate, d.qty_pcs AS qtyPcs,
              d.notes, d.voided_at AS voidedAt,
              d.model_id AS modelId, d.color_id AS colorId, d.size_id AS sizeId,
              m.image_path AS modelImagePath,
              m.code AS modelCode, m.code || '-' || s.code AS sizeCodeLabel,
              c.name AS colorName, s.code AS sizeCode
       FROM fg_dispatches d
       JOIN models m ON m.id = d.model_id
       JOIN colors c ON c.id = d.color_id
       JOIN sizes s ON s.id = d.size_id
       WHERE d.office_id = ?
       ORDER BY d.id DESC`,
    )
    .all(officeId) as Array<Record<string, unknown>>;
}
