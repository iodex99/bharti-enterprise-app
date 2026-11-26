import type { Db } from '../db/connection';
import { dozenAmount, lineAccounts } from './jobAccounts.service';

/**
 * Per-person ledgers (ADR-047): every contractor, checker and packer has an account —
 * work credited, deductions, payments — with a running balance and a breakdown that
 * shows HOW the amount owed was worked out. The same object feeds the screen and the
 * PDF statement, so the paper always matches the app.
 *
 * Rounding: money is rounded once per job line (contractors) or per issue (staff) over
 * the total pieces — the rule every other screen uses. To give each EVENT its own
 * amount without drifting from that total, an event's amount is the change in the
 * rounded running total of its line:
 *     amount_k = round(cum_k × rate / 12) − round(cum_(k−1) × rate / 12)
 * which telescopes to exactly round(total × rate / 12). Statement = dues, to the paisa.
 */

export type EntryKind = 'work' | 'check' | 'pack' | 'rework' | 'missing' | 'payment';

export type StatementEntry = {
  date: string;
  kind: EntryKind;
  /** the document this row comes from (receipt, check, pack, payment) */
  docNo: string;
  /** the work it belongs to (job card / check issue / pack issue) */
  ref: string;
  /** what: "315-HR Black", or the payment mode */
  description: string;
  /** pieces: + for work, − for deductions; null for payments */
  qtyPcs: number | null;
  ratePaisePerDozen: number | null;
  /** + increases what is owed, − reduces it */
  amountPaise: number;
  balancePaise: number;
  note: string;
};

export type BreakdownRow = {
  ref: string;
  date: string;
  item: string;
  ratePaisePerDozen: number;
  workPcs: number;
  reworkPcs: number;
  missingPcs: number;
  netPcs: number;
  amountPaise: number;
};

export type Statement = {
  party: {
    kind: 'contractor' | 'staff';
    id: number;
    name: string;
    mobile: string;
    imagePath: string | null;
    ratePaisePerDozen: number;
  };
  office: { id: number; name: string };
  period: { from: string | null; to: string | null };
  openingBalancePaise: number;
  totals: {
    workPcs: number;
    earnedPaise: number;
    reworkPcs: number;
    reworkPaise: number;
    missingPcs: number;
    missingPaise: number;
    paidPaise: number;
    closingBalancePaise: number;
  };
  breakdown: BreakdownRow[];
  entries: StatementEntry[];
};

type RawEvent = Omit<StatementEntry, 'amountPaise' | 'balancePaise'> & {
  /** grouping key for telescoped rounding */
  group: string;
  order: number;
  seq: number;
  /** pieces counted toward pay (signed) — work + / deductions − */
  payPcs: number;
};

const KIND_ORDER: Record<EntryKind, number> = {
  work: 0,
  check: 0,
  pack: 0,
  rework: 1,
  missing: 1,
  payment: 2,
};

/** Price events with telescoped rounding per group, then sort them into one timeline. */
function priceEvents(events: RawEvent[], rateOf: (group: string) => number): StatementEntry[] {
  const byGroup = new Map<string, RawEvent[]>();
  for (const e of events) {
    if (e.kind === 'payment') continue;
    const list = byGroup.get(e.group) ?? [];
    list.push(e);
    byGroup.set(e.group, list);
  }
  const amounts = new Map<RawEvent, number>();
  for (const [group, list] of byGroup) {
    list.sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order || a.seq - b.seq);
    const rate = rateOf(group);
    let cum = 0;
    let prevRounded = 0;
    for (const e of list) {
      cum += e.payPcs;
      // a line's payable pieces never go below zero (same clamp as lineAccounts)
      const rounded = dozenAmount(Math.max(0, cum), rate);
      amounts.set(e, rounded - prevRounded);
      prevRounded = rounded;
    }
  }
  const sorted = [...events].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      a.order - b.order ||
      a.seq - b.seq,
  );
  return sorted.map((e) => {
    const isPayment = e.kind === 'payment';
    return {
      date: e.date,
      kind: e.kind,
      docNo: e.docNo,
      ref: e.ref,
      description: e.description,
      qtyPcs: isPayment ? null : e.qtyPcs,
      ratePaisePerDozen: e.ratePaisePerDozen,
      // a payment's amount rides in qtyPcs until here; it reduces what is owed
      amountPaise: isPayment ? -(e.qtyPcs ?? 0) : (amounts.get(e) ?? 0),
      balancePaise: 0,
      note: e.note,
    };
  });
}

function inPeriod(date: string, from: string | null, to: string | null): boolean {
  return (!from || date >= from) && (!to || date <= to);
}

/** Opening balance, in-period rows with running balance, totals and breakdown. */
function assemble(
  base: Pick<Statement, 'party' | 'office'>,
  all: StatementEntry[],
  from: string | null,
  to: string | null,
  breakdownOf: (entries: StatementEntry[]) => BreakdownRow[],
): Statement {
  let opening = 0;
  const entries: StatementEntry[] = [];
  for (const e of all) {
    if (from && e.date < from) {
      opening += e.amountPaise;
      continue;
    }
    if (!inPeriod(e.date, from, to)) continue;
    entries.push(e);
  }
  let balance = opening;
  const totals = {
    workPcs: 0,
    earnedPaise: 0,
    reworkPcs: 0,
    reworkPaise: 0,
    missingPcs: 0,
    missingPaise: 0,
    paidPaise: 0,
    closingBalancePaise: 0,
  };
  for (const e of entries) {
    balance += e.amountPaise;
    e.balancePaise = balance;
    if (e.kind === 'payment') totals.paidPaise += -e.amountPaise;
    else if (e.kind === 'rework') {
      totals.reworkPcs += -(e.qtyPcs ?? 0);
      totals.reworkPaise += -e.amountPaise;
    } else if (e.kind === 'missing') {
      totals.missingPcs += -(e.qtyPcs ?? 0);
      totals.missingPaise += -e.amountPaise;
    } else {
      totals.workPcs += e.qtyPcs ?? 0;
      totals.earnedPaise += e.amountPaise;
    }
  }
  totals.closingBalancePaise = balance;
  return {
    ...base,
    period: { from, to },
    openingBalancePaise: opening,
    totals,
    breakdown: breakdownOf(entries),
    entries,
  };
}

function officeName(db: Db, officeId: number): { id: number; name: string } {
  const row = db.prepare('SELECT name FROM offices WHERE id = ?').get(officeId) as
    { name: string } | undefined;
  return { id: officeId, name: row?.name ?? 'Office' };
}

function paymentEvents(
  db: Db,
  table: 'contractor_payments' | 'staff_payments',
  column: 'contractor_id' | 'staff_id',
  id: number,
  officeId: number,
): RawEvent[] {
  const rows = db
    .prepare(
      `SELECT id, doc_no AS docNo, payment_date AS date, amount_paise AS amount, mode, reference, notes
       FROM ${table} WHERE ${column} = ? AND office_id = ? AND voided_at IS NULL`,
    )
    .all(id, officeId) as Array<{
    id: number;
    docNo: string;
    date: string;
    amount: number;
    mode: string;
    reference: string;
    notes: string;
  }>;
  return rows.map((p) => ({
    date: p.date,
    kind: 'payment' as const,
    docNo: p.docNo,
    ref: p.reference,
    description: p.mode,
    // carried in qtyPcs only until priced (payments are money, not pieces)
    qtyPcs: p.amount,
    ratePaisePerDozen: null,
    note: p.notes,
    group: 'payment',
    order: 0,
    seq: p.id,
    payPcs: 0,
  }));
}

export function contractorStatement(
  db: Db,
  officeId: number,
  contractorId: number,
  period: { from?: string | null; to?: string | null } = {},
): Statement | null {
  const person = db
    .prepare(
      `SELECT id, name, mobile, image_path AS imagePath, default_rate_paise_per_dozen AS rate
       FROM contractors WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(contractorId) as
    | { id: number; name: string; mobile: string; imagePath: string | null; rate: number }
    | undefined;
  if (!person) return null;

  const lines = lineAccounts(db, officeId, { contractorId });
  const lineById = new Map(lines.map((l) => [l.lineId, l]));
  const itemOf = (lineId: number): string => {
    const l = lineById.get(lineId)!;
    return `${l.modelCode}-${l.sizeCode} ${l.colorName}`;
  };

  const events: RawEvent[] = [];
  if (lines.length > 0) {
    const ids = lines.map((l) => l.lineId).join(',');
    const receipts = db
      .prepare(
        `SELECT rl.id, rl.job_card_line_id AS lineId, rl.qty_pcs AS qty, r.doc_no AS docNo,
                r.receipt_date AS date, r.notes
         FROM job_receipt_lines rl
         JOIN job_receipts r ON r.id = rl.job_receipt_id AND r.voided_at IS NULL
         WHERE rl.return_type = 'stitched' AND rl.job_card_line_id IN (${ids})`,
      )
      .all() as Array<{
      id: number;
      lineId: number;
      qty: number;
      docNo: string;
      date: string;
      notes: string;
    }>;
    for (const r of receipts) {
      const l = lineById.get(r.lineId)!;
      events.push({
        date: r.date,
        kind: 'work',
        docNo: r.docNo,
        ref: l.jobDocNo,
        description: itemOf(r.lineId),
        qtyPcs: r.qty,
        ratePaisePerDozen: l.ratePaisePerDozen,
        note: r.notes,
        group: String(r.lineId),
        order: 0,
        seq: r.id,
        payPcs: r.qty,
      });
    }
    const adjustments = db
      .prepare(
        `SELECT a.id, a.job_card_line_id AS lineId, a.kind, a.reason, a.qty_pcs AS qty, a.adj_date AS date,
                ci.doc_no AS checkDocNo
         FROM contractor_adjustments a
         JOIN check_issues ci ON ci.id = a.check_issue_id
         WHERE a.job_card_line_id IN (${ids})`,
      )
      .all() as Array<{
      id: number;
      lineId: number;
      kind: 'rework' | 'missing';
      reason: string;
      qty: number;
      date: string;
      checkDocNo: string;
    }>;
    for (const a of adjustments) {
      const l = lineById.get(a.lineId)!;
      events.push({
        date: a.date,
        kind: a.kind,
        docNo: a.checkDocNo,
        ref: l.jobDocNo,
        description: itemOf(a.lineId),
        qtyPcs: -a.qty,
        ratePaisePerDozen: l.ratePaisePerDozen,
        note: a.reason,
        group: String(a.lineId),
        order: 1,
        seq: a.id,
        payPcs: -a.qty,
      });
    }
  }
  events.push(...paymentEvents(db, 'contractor_payments', 'contractor_id', contractorId, officeId));

  const priced = priceEvents(
    events,
    (group) => lineById.get(Number(group))?.ratePaisePerDozen ?? 0,
  );
  const from = period.from || null;
  const to = period.to || null;
  return assemble(
    {
      party: {
        kind: 'contractor',
        id: person.id,
        name: person.name,
        mobile: person.mobile ?? '',
        imagePath: person.imagePath,
        ratePaisePerDozen: person.rate,
      },
      office: officeName(db, officeId),
    },
    priced,
    from,
    to,
    (entries) => {
      // per job line: what was received, sent back, missing — and what it came to
      const rows = new Map<string, BreakdownRow>();
      for (const e of entries) {
        if (e.kind === 'payment') continue;
        const key = `${e.ref}|${e.description}|${e.ratePaisePerDozen}`;
        const row =
          rows.get(key) ??
          ({
            ref: e.ref,
            date: e.date,
            item: e.description,
            ratePaisePerDozen: e.ratePaisePerDozen ?? 0,
            workPcs: 0,
            reworkPcs: 0,
            missingPcs: 0,
            netPcs: 0,
            amountPaise: 0,
          } satisfies BreakdownRow);
        if (e.kind === 'rework') row.reworkPcs += -(e.qtyPcs ?? 0);
        else if (e.kind === 'missing') row.missingPcs += -(e.qtyPcs ?? 0);
        else row.workPcs += e.qtyPcs ?? 0;
        row.netPcs = row.workPcs - row.reworkPcs - row.missingPcs;
        row.amountPaise += e.amountPaise;
        rows.set(key, row);
      }
      return [...rows.values()];
    },
  );
}

export function staffStatement(
  db: Db,
  officeId: number,
  staffId: number,
  period: { from?: string | null; to?: string | null } = {},
): Statement | null {
  const person = db
    .prepare(
      `SELECT id, name, mobile, image_path AS imagePath, default_rate_paise_per_dozen AS rate
       FROM staff WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(staffId) as
    | { id: number; name: string; mobile: string; imagePath: string | null; rate: number }
    | undefined;
  if (!person) return null;

  const events: RawEvent[] = [];
  const rates = new Map<string, number>();

  // checking pays for pieces actually inspected (passed + rejected) — never missing
  const checks = db
    .prepare(
      `SELECT r.id, r.result_date AS date, r.qty_passed + r.qty_rejected AS qty, r.notes,
              ci.id AS issueId, ci.doc_no AS docNo, ci.rate_paise_per_dozen AS rate,
              m.code || '-' || s.code || ' ' || c.name AS item
       FROM check_results r
       JOIN check_issues ci ON ci.id = r.check_issue_id AND ci.voided_at IS NULL
       JOIN models m ON m.id = ci.model_id
       JOIN colors c ON c.id = ci.color_id
       JOIN sizes s ON s.id = ci.size_id
       WHERE ci.staff_id = ? AND ci.office_id = ? AND r.qty_passed + r.qty_rejected > 0`,
    )
    .all(staffId, officeId) as Array<{
    id: number;
    date: string;
    qty: number;
    notes: string;
    issueId: number;
    docNo: string;
    rate: number;
    item: string;
  }>;
  for (const c of checks) {
    const group = `c${c.issueId}`;
    rates.set(group, c.rate);
    events.push({
      date: c.date,
      kind: 'check',
      docNo: c.docNo,
      ref: c.docNo,
      description: c.item,
      qtyPcs: c.qty,
      ratePaisePerDozen: c.rate,
      note: c.notes,
      group,
      order: 0,
      seq: c.id,
      payPcs: c.qty,
    });
  }

  const packs = db
    .prepare(
      `SELECT pr.id, pr.result_date AS date, pr.qty_packed AS qty, pr.notes,
              pi.id AS issueId, pi.doc_no AS docNo, pi.rate_paise_per_dozen AS rate,
              m.code || '-' || s.code || ' ' || c.name AS item
       FROM pack_results pr
       JOIN pack_issues pi ON pi.id = pr.pack_issue_id AND pi.voided_at IS NULL
       JOIN models m ON m.id = pi.model_id
       JOIN colors c ON c.id = pi.color_id
       JOIN sizes s ON s.id = pi.size_id
       WHERE pi.staff_id = ? AND pi.office_id = ? AND pr.qty_packed > 0`,
    )
    .all(staffId, officeId) as Array<{
    id: number;
    date: string;
    qty: number;
    notes: string;
    issueId: number;
    docNo: string;
    rate: number;
    item: string;
  }>;
  for (const p of packs) {
    const group = `p${p.issueId}`;
    rates.set(group, p.rate);
    events.push({
      date: p.date,
      kind: 'pack',
      docNo: p.docNo,
      ref: p.docNo,
      description: p.item,
      qtyPcs: p.qty,
      ratePaisePerDozen: p.rate,
      note: p.notes,
      group,
      order: 0,
      seq: p.id,
      payPcs: p.qty,
    });
  }
  events.push(...paymentEvents(db, 'staff_payments', 'staff_id', staffId, officeId));

  const priced = priceEvents(events, (group) => rates.get(group) ?? 0);
  return assemble(
    {
      party: {
        kind: 'staff',
        id: person.id,
        name: person.name,
        mobile: person.mobile ?? '',
        imagePath: person.imagePath,
        ratePaisePerDozen: person.rate,
      },
      office: officeName(db, officeId),
    },
    priced,
    period.from || null,
    period.to || null,
    (entries) => {
      const rows = new Map<string, BreakdownRow>();
      for (const e of entries) {
        if (e.kind === 'payment') continue;
        const key = `${e.kind}|${e.ref}`;
        const row =
          rows.get(key) ??
          ({
            ref: e.ref,
            date: e.date,
            item: `${e.kind === 'check' ? 'Checked' : 'Packed'} ${e.description}`,
            ratePaisePerDozen: e.ratePaisePerDozen ?? 0,
            workPcs: 0,
            reworkPcs: 0,
            missingPcs: 0,
            netPcs: 0,
            amountPaise: 0,
          } satisfies BreakdownRow);
        row.workPcs += e.qtyPcs ?? 0;
        row.netPcs = row.workPcs;
        row.amountPaise += e.amountPaise;
        rows.set(key, row);
      }
      return [...rows.values()];
    },
  );
}
