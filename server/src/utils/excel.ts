import ExcelJS from 'exceljs';
import type { Response } from 'express';
import { formatPieces } from '@shared';
import type { ReportColumn } from '../services/reports.service';

/**
 * Generic .xlsx writer used by every report (spec: all reports Excel-exportable).
 * Column defs are the SAME objects the API sends to the on-screen table, so the
 * export can never drift from the screen.
 */
export async function sendXlsx(
  res: Response,
  opts: {
    title: string;
    subtitle?: string;
    columns: ReportColumn[];
    rows: Array<Record<string, unknown>>;
    filename: string;
  },
): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Bharti Enterprises System';
  const sheet = workbook.addWorksheet(opts.title.slice(0, 31), {
    views: [{ state: 'frozen', ySplit: opts.subtitle ? 3 : 2 }],
  });

  // title + subtitle
  const titleRow = sheet.addRow([opts.title]);
  titleRow.font = { bold: true, size: 14 };
  sheet.mergeCells(1, 1, 1, Math.max(opts.columns.length, 1));
  if (opts.subtitle) {
    const sub = sheet.addRow([opts.subtitle]);
    sub.font = { size: 10, color: { argb: 'FF666666' } };
    sheet.mergeCells(2, 1, 2, Math.max(opts.columns.length, 1));
  }

  // header
  const header = sheet.addRow(opts.columns.map((c) => c.header));
  header.font = { bold: true };
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDE9FE' } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFCCCCCC' } } };
  });

  // data
  for (const row of opts.rows) {
    const values = opts.columns.map((c) => cellValue(c, row[c.key]));
    const added = sheet.addRow(values);
    opts.columns.forEach((c, i) => {
      const cell = added.getCell(i + 1);
      if (c.type === 'paise') cell.numFmt = '₹#,##0.00';
      if (c.type === 'cm') cell.numFmt = '#,##0.00 "m"';
      if (c.type === 'pct') cell.numFmt = '0.0"%"';
      if (c.type === 'date') cell.numFmt = 'dd/mm/yyyy';
    });
  }

  // totals for numeric columns
  const numericTypes = new Set(['pcs', 'cm', 'paise', 'int']);
  if (opts.rows.length > 1 && opts.columns.some((c) => numericTypes.has(c.type))) {
    const totals = opts.columns.map((c, i) => {
      if (i === 0) return 'TOTAL';
      if (!numericTypes.has(c.type)) return '';
      const sum = opts.rows.reduce((s, r) => s + (Number(r[c.key]) || 0), 0);
      return cellValue(c, sum);
    });
    const totalRow = sheet.addRow(totals);
    totalRow.font = { bold: true };
    opts.columns.forEach((c, i) => {
      const cell = totalRow.getCell(i + 1);
      if (c.type === 'paise') cell.numFmt = '₹#,##0.00';
      if (c.type === 'cm') cell.numFmt = '#,##0.00 "m"';
      cell.border = { top: { style: 'thin', color: { argb: 'FF999999' } } };
    });
  }

  // widths
  opts.columns.forEach((c, i) => {
    const maxData = Math.max(
      c.header.length,
      ...opts.rows.slice(0, 200).map((r) => String(cellValue(c, r[c.key]) ?? '').length),
    );
    sheet.getColumn(i + 1).width = Math.min(Math.max(maxData + 2, 10), 40);
  });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${opts.filename}"`);
  await workbook.xlsx.write(res);
  res.end();
}

function cellValue(column: ReportColumn, value: unknown): unknown {
  if (value == null) return '';
  switch (column.type) {
    case 'pcs':
      return formatPieces(Number(value)); // owners read "2dz 6pc", not 30
    case 'cm':
      return Number(value) / 100; // meters as a real number
    case 'paise':
      return Number(value) / 100; // rupees as a real number
    case 'date': {
      const parsed = new Date(`${String(value)}T00:00:00Z`);
      return Number.isNaN(parsed.getTime()) ? String(value) : parsed;
    }
    case 'pct':
    case 'int':
      return Number(value);
    default:
      return String(value);
  }
}
