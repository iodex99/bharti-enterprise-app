import ExcelJS from 'exceljs';
import { formatBusinessDate, formatLen, formatPaise, formatPieces } from '@shared';
import type { Db } from '../db/connection';
import { REPORTS, type ReportFilters } from '../services/reports.service';
import { dashboardData } from '../services/dashboard.service';
import { addReportSheet } from './excel';
import { formatValue, NUMERIC_TYPES } from './formatValue';

/**
 * The Complete Business Report — every report in one document.
 * HTML: a self-contained, print-ready file (inline CSS, CSS-bar charts on the
 * validated dataviz palette, direct value labels). XLSX: one styled worksheet per
 * report plus an executive-summary sheet.
 */

const GROUP_ORDER = ['Inventory', 'Production', 'Contractors', 'Quality', 'Losses', 'Management'];

function periodLabel(f: ReportFilters): string {
  if (!f.from && !f.to) return 'All time';
  return `${f.from ? formatBusinessDate(f.from) : 'Beginning'} to ${f.to ? formatBusinessDate(f.to) : 'today'}`;
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

export function buildFullWorkbook(db: Db, f: ReportFilters): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Bharti Enterprises System';

  // executive summary sheet
  const dash = dashboardData(db, f.officeId) as {
    kpis: Record<string, number>;
  };
  const summary = workbook.addWorksheet('Summary');
  summary.getColumn(1).width = 34;
  summary.getColumn(2).width = 22;
  const title = summary.addRow(['Bharti Enterprises — Complete Business Report']);
  title.font = { bold: true, size: 14 };
  summary.addRow([`Period: ${periodLabel(f)} · generated ${formatBusinessDate(new Date().toISOString().slice(0, 10))}`]).font = {
    size: 10,
    color: { argb: 'FF666666' },
  };
  summary.addRow([]);
  const kpiRows: Array<[string, string]> = [
    ['Raw cloth in stock', formatLen(dash.kpis.rawLen!)],
    ['Cut pieces in stock', formatPieces(dash.kpis.cutPcs!)],
    ['With contractors (WIP)', formatPieces(dash.kpis.wipPcs!)],
    ['In checking', formatPieces(dash.kpis.checkingPcs!)],
    ['In packing', formatPieces(dash.kpis.packingPcs!)],
    ['Finished goods', formatPieces(dash.kpis.fgPcs!)],
    ['Rejected stock', formatPieces(dash.kpis.rejectedPcs!)],
    ['Open jobs', String(dash.kpis.openJobs)],
    ['Delayed jobs', String(dash.kpis.delayedJobs)],
    ['Pending from contractors', formatPieces(dash.kpis.pendingReceiptsPcs!)],
    ['Unresolved discrepancies', String(dash.kpis.unresolvedDiscrepancies)],
    ['Contractor dues', formatPaise(dash.kpis.duesPaise!)],
  ];
  const header = summary.addRow(['Key figure', 'Value']);
  header.font = { bold: true };
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDE9FE' } };
  });
  for (const [label, value] of kpiRows) {
    const row = summary.addRow([label, value]);
    row.getCell(2).alignment = { horizontal: 'right' };
  }

  // one sheet per report
  for (const group of GROUP_ORDER) {
    for (const report of REPORTS.filter((r) => r.group === group)) {
      const rows = report.query(db, f);
      addReportSheet(workbook, {
        title: report.title,
        subtitle: `${report.group} · ${periodLabel(f)}`,
        columns: report.columns,
        rows,
        sheetName: report.title,
      });
    }
  }
  return workbook;
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function barChart(
  items: Array<{ label: string; value: number; display: string }>,
  color = '#2a78d6',
): string {
  const max = Math.max(...items.map((i) => i.value), 1);
  return `<div class="bars">${items
    .map(
      (i) => `<div class="bar-row">
        <div class="bar-label">${esc(i.label)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.max((i.value / max) * 100, 1)}%;background:${color}"></div></div>
        <div class="bar-value">${esc(i.display)}</div>
      </div>`,
    )
    .join('')}</div>`;
}

export function buildFullReportHtml(db: Db, f: ReportFilters): string {
  const dash = dashboardData(db, f.officeId) as {
    kpis: Record<string, number>;
    contractorBars: Array<{ name: string; receivedPcs: number }>;
    rejectionReasons: Array<{ reason: string; qtyPcs: number }>;
    fgByModel: Array<{ model: string; qtyPcs: number }>;
    trends: Array<{ month: string; cutPcs: number; receivedPcs: number; packedPcs: number }>;
  };
  const generated = formatBusinessDate(new Date().toISOString().slice(0, 10));

  const kpis: Array<[string, string]> = [
    ['Raw cloth', formatLen(dash.kpis.rawLen!)],
    ['Cut pieces', formatPieces(dash.kpis.cutPcs!)],
    ['With contractors', formatPieces(dash.kpis.wipPcs!)],
    ['In checking', formatPieces(dash.kpis.checkingPcs!)],
    ['In packing', formatPieces(dash.kpis.packingPcs!)],
    ['Finished goods', formatPieces(dash.kpis.fgPcs!)],
    ['Rejected', formatPieces(dash.kpis.rejectedPcs!)],
    ['Open jobs', String(dash.kpis.openJobs)],
    ['Delayed jobs', String(dash.kpis.delayedJobs)],
    ['Pending w/ contractors', formatPieces(dash.kpis.pendingReceiptsPcs!)],
    ['Unresolved discrepancies', String(dash.kpis.unresolvedDiscrepancies)],
    ['Contractor dues', formatPaise(dash.kpis.duesPaise!)],
  ];

  const sections = GROUP_ORDER.map((group) => {
    const tables = REPORTS.filter((r) => r.group === group)
      .map((report) => {
        const rows = report.query(db, f);
        const head = report.columns.map((c) => `<th class="${NUMERIC_TYPES.has(c.type) ? 'num' : ''}">${esc(c.header)}</th>`).join('');
        const body =
          rows.length === 0
            ? `<tr><td colspan="${report.columns.length}" class="empty">No data for this period</td></tr>`
            : rows
                .map(
                  (row) =>
                    `<tr>${report.columns
                      .map((c) => `<td class="${NUMERIC_TYPES.has(c.type) ? 'num' : ''}">${esc(formatValue(c.type, row[c.key]))}</td>`)
                      .join('')}</tr>`,
                )
                .join('');
        return `<div class="report">
          <h3>${esc(report.title)}</h3>
          <p class="desc">${esc(report.description)} · ${rows.length} row${rows.length === 1 ? '' : 's'}</p>
          <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
        </div>`;
      })
      .join('');
    return `<section><h2>${esc(group)}</h2>${tables}</section>`;
  }).join('');

  const trendTable = dash.trends
    .map(
      (t) =>
        `<tr><td>${esc(t.month)}</td><td class="num">${formatPieces(t.cutPcs)}</td><td class="num">${formatPieces(t.receivedPcs)}</td><td class="num">${formatPieces(t.packedPcs)}</td></tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bharti Enterprises — Complete Business Report</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; margin: 0; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #0b0b0b;
         background: #f9f9f7; padding: 24px; font-size: 13px; line-height: 1.45; }
  .page { max-width: 960px; margin: 0 auto; }
  header.rep { background: #fff; border: 1px solid #e1e0d9; border-radius: 14px; padding: 20px 24px; margin-bottom: 18px; }
  header.rep h1 { font-size: 20px; }
  header.rep .meta { color: #52514e; font-size: 12px; margin-top: 4px; }
  .brand { display:inline-block; width: 26px; height: 26px; border-radius: 8px; background: #7c3aed;
           color:#fff; text-align:center; line-height:26px; font-weight:700; margin-right: 8px; vertical-align: -6px; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; margin-bottom: 18px; }
  .kpi { background: #fff; border: 1px solid #e1e0d9; border-radius: 12px; padding: 10px 12px; }
  .kpi .l { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: #898781; }
  .kpi .v { font-size: 15px; font-weight: 700; margin-top: 2px; }
  .charts { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 18px; }
  @media (max-width: 720px) { .charts { grid-template-columns: 1fr; } }
  .chart { background: #fff; border: 1px solid #e1e0d9; border-radius: 12px; padding: 14px 16px; }
  .chart h3 { font-size: 13px; margin-bottom: 8px; }
  .bars .bar-row { display: grid; grid-template-columns: 120px 1fr 64px; gap: 8px; align-items: center; margin: 4px 0; }
  .bar-label { font-size: 11px; color: #52514e; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar-track { background: #f0efec; border-radius: 4px; height: 14px; }
  .bar-fill { height: 100%; border-radius: 4px 4px 4px 4px; min-width: 2px; }
  .bar-value { font-size: 11px; color: #52514e; font-weight: 600; }
  section { margin-bottom: 22px; }
  section > h2 { font-size: 15px; margin: 18px 0 8px; padding-bottom: 4px; border-bottom: 2px solid #7c3aed; }
  .report { background: #fff; border: 1px solid #e1e0d9; border-radius: 12px; padding: 14px 16px; margin-bottom: 12px;
            break-inside: avoid; overflow-x: auto; }
  .report h3 { font-size: 13px; }
  .report .desc { color: #898781; font-size: 11px; margin: 2px 0 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: #898781;
       border-bottom: 1px solid #c3c2b7; padding: 5px 8px; }
  td { padding: 5px 8px; border-bottom: 1px solid #efeeea; }
  tr:nth-child(even) td { background: #fbfbf9; }
  th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.empty { color: #c3c2b7; text-align: center; padding: 14px; }
  footer { color: #898781; font-size: 11px; margin-top: 16px; text-align: center; }
  @media print {
    body { background: #fff; padding: 0; font-size: 11px; }
    .report, .chart, .kpi, header.rep { border-color: #ddd; }
  }
</style>
</head>
<body>
<div class="page">
  <header class="rep">
    <h1><span class="brand">B</span>Bharti Enterprises — Complete Business Report</h1>
    <div class="meta">Period: ${esc(periodLabel(f))} · Generated: ${esc(generated)} · Production &amp; Inventory Management System</div>
  </header>

  <div class="kpis">
    ${kpis.map(([l, v]) => `<div class="kpi"><div class="l">${esc(l)}</div><div class="v">${esc(v)}</div></div>`).join('')}
  </div>

  <div class="charts">
    <div class="chart"><h3>Stitched pieces received per contractor</h3>
      ${dash.contractorBars.length ? barChart(dash.contractorBars.map((c) => ({ label: c.name, value: c.receivedPcs, display: formatPieces(c.receivedPcs) }))) : '<p class="desc">No data</p>'}
    </div>
    <div class="chart"><h3>Why pieces fail checking</h3>
      ${dash.rejectionReasons.length ? barChart(dash.rejectionReasons.map((r) => ({ label: r.reason, value: r.qtyPcs, display: formatPieces(r.qtyPcs) }))) : '<p class="desc">No rejections recorded</p>'}
    </div>
    <div class="chart"><h3>Finished goods by model</h3>
      ${dash.fgByModel.length ? barChart(dash.fgByModel.map((m) => ({ label: m.model, value: m.qtyPcs, display: formatPieces(m.qtyPcs) }))) : '<p class="desc">No finished goods</p>'}
    </div>
    <div class="chart"><h3>Monthly production</h3>
      <table><thead><tr><th>Month</th><th class="num">Cut</th><th class="num">Received</th><th class="num">Packed</th></tr></thead>
      <tbody>${trendTable || '<tr><td colspan="4" class="empty">No data</td></tr>'}</tbody></table>
    </div>
  </div>

  ${sections}

  <footer>Numbers derive from the append-only stock ledger; every figure is traceable to its transaction. · Bharti Enterprises System</footer>
</div>
</body>
</html>`;
}
