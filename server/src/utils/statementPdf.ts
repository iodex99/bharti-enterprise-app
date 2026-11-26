import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { formatBusinessDate, formatPieces, formatTimestampIST } from '@shared';
import type { Statement, StatementEntry } from '../services/statements.service';

/**
 * The printable statement sent to a contractor / checker / packer (ADR-047).
 * pdf-lib with the built-in Helvetica: pure JS, nothing to install on the office PC,
 * and the file is generated from the SAME Statement object the screen shows.
 *
 * Helvetica only speaks WinAnsi, so text is passed through `safe()` (₹ → "Rs.",
 * typographic dashes → "-", anything else unencodable → "?") rather than letting one
 * unusual character in a name break the whole PDF.
 */

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 36;
const INK = rgb(0.13, 0.13, 0.16);
const MUTED = rgb(0.42, 0.44, 0.5);
const RULE = rgb(0.86, 0.87, 0.9);
const BRAND = rgb(0.43, 0.25, 0.83);
const TINT = rgb(0.96, 0.95, 1);
const AMBER = rgb(0.6, 0.33, 0.02);

const REPLACE: Record<string, string> = {
  '₹': 'Rs.',
  '—': '-',
  '–': '-',
  '−': '-',
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '…': '...',
  ' ': ' ',
};

function safe(text: string): string {
  let out = '';
  for (const ch of text) {
    if (REPLACE[ch] !== undefined) out += REPLACE[ch];
    else if (ch === '\n' || ch === '\t') out += ' ';
    else {
      const code = ch.codePointAt(0)!;
      // printable ASCII + the Latin-1 range Helvetica's WinAnsi encoding covers
      out += (code >= 0x20 && code <= 0x7e) || (code >= 0xa1 && code <= 0xff) ? ch : '?';
    }
  }
  return out;
}

const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function rupees(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  return `${sign}Rs. ${inr.format(Math.abs(paise) / 100)}`;
}

type Col = { header: string; width: number; align?: 'left' | 'right' };

class Writer {
  doc: PDFDocument;
  page!: PDFPage;
  y = 0;
  constructor(
    doc: PDFDocument,
    readonly font: PDFFont,
    readonly bold: PDFFont,
    readonly footer: string,
  ) {
    this.doc = doc;
    this.newPage();
  }

  newPage(): void {
    this.page = this.doc.addPage(A4);
    this.y = A4[1] - MARGIN;
  }

  /** Start a new page if fewer than `needed` points are left above the footer. */
  ensure(needed: number): boolean {
    if (this.y - needed < MARGIN + 24) {
      this.newPage();
      return true;
    }
    return false;
  }

  text(
    value: string,
    x: number,
    y: number,
    opts: {
      size?: number;
      bold?: boolean;
      color?: ReturnType<typeof rgb>;
      maxWidth?: number;
      align?: 'left' | 'right';
    } = {},
  ): void {
    const font = opts.bold ? this.bold : this.font;
    const size = opts.size ?? 9;
    let s = safe(value);
    if (opts.maxWidth) {
      // trim to fit the column, marking the cut with a dot
      while (s.length > 1 && font.widthOfTextAtSize(s, size) > opts.maxWidth)
        s = `${s.slice(0, -2)}.`;
    }
    const w = font.widthOfTextAtSize(s, size);
    this.page.drawText(s, {
      x: opts.align === 'right' ? x - w : x,
      y,
      size,
      font,
      color: opts.color ?? INK,
    });
  }

  rule(y: number, color = RULE): void {
    this.page.drawLine({
      start: { x: MARGIN, y },
      end: { x: A4[0] - MARGIN, y },
      thickness: 0.6,
      color,
    });
  }

  table(title: string, cols: Col[], rows: string[][], opts: { boldLast?: boolean } = {}): void {
    const rowH = 15;
    const drawHeader = () => {
      this.page.drawRectangle({
        x: MARGIN,
        y: this.y - 16,
        width: A4[0] - 2 * MARGIN,
        height: 18,
        color: TINT,
      });
      let x = MARGIN + 4;
      for (const c of cols) {
        this.text(c.header.toUpperCase(), c.align === 'right' ? x + c.width - 8 : x, this.y - 11, {
          size: 7,
          bold: true,
          color: MUTED,
          align: c.align,
        });
        x += c.width;
      }
      this.y -= 20;
    };
    this.ensure(60);
    this.text(title, MARGIN, this.y - 12, { size: 11, bold: true });
    this.y -= 20;
    drawHeader();
    rows.forEach((row, i) => {
      if (this.ensure(rowH + 4)) {
        this.text(`${title} (continued)`, MARGIN, this.y - 12, {
          size: 9,
          bold: true,
          color: MUTED,
        });
        this.y -= 18;
        drawHeader();
      }
      const isLast = opts.boldLast && i === rows.length - 1;
      let x = MARGIN + 4;
      cols.forEach((c, ci) => {
        this.text(row[ci] ?? '', c.align === 'right' ? x + c.width - 8 : x, this.y - 10, {
          size: 8.5,
          bold: isLast,
          align: c.align,
          maxWidth: c.width - 8,
        });
        x += c.width;
      });
      this.y -= rowH;
      this.rule(this.y + 2);
    });
    if (rows.length === 0) {
      this.text('Nothing in this period.', MARGIN + 4, this.y - 11, { size: 8.5, color: MUTED });
      this.y -= rowH;
    }
    this.y -= 12;
  }

  finish(): void {
    const pages = this.doc.getPages();
    pages.forEach((p, i) => {
      const text = safe(`${this.footer}   ·   Page ${i + 1} of ${pages.length}`);
      p.drawText(text, { x: MARGIN, y: MARGIN - 6, size: 7.5, font: this.font, color: MUTED });
    });
  }
}

function particulars(e: StatementEntry): string {
  switch (e.kind) {
    case 'work':
      return `Received ${e.description} (${e.ref})`;
    case 'check':
      return `Checked ${e.description}`;
    case 'pack':
      return `Packed ${e.description}`;
    case 'rework':
      return `Sent back for rework: ${e.description} (${e.ref})${e.note ? ` - ${e.note.replace(/_/g, ' ')}` : ''}`;
    case 'missing':
      return `Missing at checking: ${e.description} (${e.ref})`;
    case 'payment':
      return `Payment - ${e.description.replace(/_/g, ' ')}${e.ref ? ` (${e.ref})` : ''}`;
  }
}

export async function renderStatementPdf(
  st: Statement,
  generatedAtIso: string,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const who = st.party.kind === 'contractor' ? 'Contractor' : 'Checker / Packer';
  doc.setTitle(safe(`Statement - ${st.party.name}`));
  doc.setAuthor('Bharti Enterprises');
  doc.setCreator('Bharti Enterprises Production & Inventory');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const w = new Writer(
    doc,
    font,
    bold,
    `Bharti Enterprises · ${st.office.name} · generated ${formatTimestampIST(generatedAtIso)} IST`,
  );

  // ---- header
  const top = w.y;
  w.page.drawRectangle({ x: MARGIN, y: top - 4, width: 4, height: 40, color: BRAND });
  w.text('BHARTI ENTERPRISES', MARGIN + 12, top - 14, { size: 15, bold: true });
  w.text(st.office.name, MARGIN + 12, top - 30, { size: 9, color: MUTED });
  w.text('PAYMENT STATEMENT', A4[0] - MARGIN, top - 14, {
    size: 12,
    bold: true,
    color: BRAND,
    align: 'right',
  });
  const periodText =
    st.period.from || st.period.to
      ? `${st.period.from ? formatBusinessDate(st.period.from) : 'Start'} to ${st.period.to ? formatBusinessDate(st.period.to) : 'today'}`
      : 'All time';
  w.text(`Period: ${periodText}`, A4[0] - MARGIN, top - 30, {
    size: 9,
    color: MUTED,
    align: 'right',
  });
  w.y = top - 52;
  w.rule(w.y);

  // ---- party
  w.y -= 18;
  w.text(st.party.name, MARGIN, w.y, { size: 13, bold: true });
  w.text(`${who}${st.party.mobile ? `  ·  ${st.party.mobile}` : ''}`, MARGIN, w.y - 14, {
    size: 9,
    color: MUTED,
  });
  w.y -= 34;

  // ---- summary box: the calculation in five lines
  const t = st.totals;
  const lines: Array<[string, string, boolean?]> = [];
  if (st.period.from)
    lines.push(['Opening balance (before this period)', rupees(st.openingBalancePaise)]);
  lines.push([
    st.party.kind === 'contractor'
      ? `Work received: ${formatPieces(t.workPcs)}`
      : `Work done: ${formatPieces(t.workPcs)}`,
    rupees(t.earnedPaise),
  ]);
  if (t.reworkPcs > 0)
    lines.push([
      `Less: sent back for rework, ${formatPieces(t.reworkPcs)}`,
      rupees(-t.reworkPaise),
    ]);
  if (t.missingPcs > 0)
    lines.push([
      `Less: missing at checking, ${formatPieces(t.missingPcs)}`,
      rupees(-t.missingPaise),
    ]);
  lines.push(['Less: paid', rupees(-t.paidPaise)]);
  lines.push([
    t.closingBalancePaise >= 0 ? 'BALANCE DUE' : 'ADVANCE (paid more than earned)',
    rupees(Math.abs(t.closingBalancePaise)),
    true,
  ]);

  const boxH = lines.length * 17 + 14;
  w.page.drawRectangle({
    x: MARGIN,
    y: w.y - boxH,
    width: A4[0] - 2 * MARGIN,
    height: boxH,
    color: TINT,
    borderColor: RULE,
    borderWidth: 0.6,
  });
  let ly = w.y - 18;
  for (const [label, value, strong] of lines) {
    if (strong) {
      w.page.drawLine({
        start: { x: MARGIN + 10, y: ly + 12 },
        end: { x: A4[0] - MARGIN - 10, y: ly + 12 },
        thickness: 0.8,
        color: MUTED,
      });
    }
    w.text(label, MARGIN + 12, ly, {
      size: strong ? 11 : 9.5,
      bold: !!strong,
      color: strong ? AMBER : INK,
    });
    w.text(value, A4[0] - MARGIN - 12, ly, {
      size: strong ? 12 : 9.5,
      bold: !!strong,
      color: strong ? AMBER : INK,
      align: 'right',
    });
    ly -= 17;
  }
  w.y -= boxH + 22;

  // ---- how it was worked out
  const isContractor = st.party.kind === 'contractor';
  const bCols: Col[] = isContractor
    ? [
        { header: 'Job', width: 62 },
        { header: 'Item', width: 128 },
        { header: 'Rate/dz', width: 56, align: 'right' },
        { header: 'Received', width: 58, align: 'right' },
        { header: 'Rework', width: 52, align: 'right' },
        { header: 'Missing', width: 52, align: 'right' },
        { header: 'Payable', width: 56, align: 'right' },
        { header: 'Amount', width: 59.28, align: 'right' },
      ]
    : [
        { header: 'Doc', width: 70 },
        { header: 'Work', width: 220 },
        { header: 'Rate/dz', width: 70, align: 'right' },
        { header: 'Pieces', width: 80, align: 'right' },
        { header: 'Amount', width: 83.28, align: 'right' },
      ];
  const bRows = st.breakdown.map((b) =>
    isContractor
      ? [
          b.ref,
          b.item,
          rupees(b.ratePaisePerDozen),
          formatPieces(b.workPcs),
          b.reworkPcs ? `-${formatPieces(b.reworkPcs)}` : '-',
          b.missingPcs ? `-${formatPieces(b.missingPcs)}` : '-',
          formatPieces(b.netPcs),
          rupees(b.amountPaise),
        ]
      : [
          b.ref,
          b.item,
          rupees(b.ratePaisePerDozen),
          formatPieces(b.workPcs),
          rupees(b.amountPaise),
        ],
  );
  const bTotal = st.breakdown.reduce((s, b) => s + b.amountPaise, 0);
  if (bRows.length > 0) {
    bRows.push(
      isContractor
        ? [
            '',
            'Total',
            '',
            formatPieces(t.workPcs),
            t.reworkPcs ? `-${formatPieces(t.reworkPcs)}` : '-',
            t.missingPcs ? `-${formatPieces(t.missingPcs)}` : '-',
            formatPieces(t.workPcs - t.reworkPcs - t.missingPcs),
            rupees(bTotal),
          ]
        : ['', 'Total', '', formatPieces(t.workPcs), rupees(bTotal)],
    );
  }
  w.text('Amount = payable pieces x rate per dozen / 12', MARGIN, w.y - 2, {
    size: 8,
    color: MUTED,
  });
  w.y -= 6;
  w.table('How the amount was worked out', bCols, bRows, { boldLast: bRows.length > 0 });

  // ---- ledger
  const eCols: Col[] = [
    { header: 'Date', width: 58 },
    { header: 'Particulars', width: 236 },
    { header: 'Doc', width: 70 },
    { header: 'Amount', width: 76, align: 'right' },
    { header: 'Balance', width: 83.28, align: 'right' },
  ];
  const eRows: string[][] = [];
  if (st.period.from)
    eRows.push([
      formatBusinessDate(st.period.from),
      'Opening balance',
      '',
      '',
      rupees(st.openingBalancePaise),
    ]);
  for (const e of st.entries) {
    eRows.push([
      formatBusinessDate(e.date),
      particulars(e) +
        (e.qtyPcs != null && e.kind !== 'payment' ? `  ${formatPieces(Math.abs(e.qtyPcs))}` : ''),
      e.docNo,
      rupees(e.amountPaise),
      rupees(e.balancePaise),
    ]);
  }
  w.table('Account ledger', eCols, eRows);

  w.ensure(40);
  w.text(
    'Please check this statement and tell the office of any difference within 7 days.',
    MARGIN,
    w.y - 4,
    {
      size: 8,
      color: MUTED,
    },
  );

  w.finish();
  return doc.save();
}
