import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatBusinessDate, formatCm, formatPaise, formatPieces } from '@shared';
import { api } from '../../api/client';
import { Button, EmptyState, Field, Select, Spinner, TextInput } from '../../components/ui';
import { MasterSelect } from '../../components/MasterSelect';

type ReportColumn = { key: string; header: string; type: string };
type ReportMeta = {
  key: string;
  title: string;
  group: string;
  description: string;
  filters: string[];
  columns: ReportColumn[];
};

const FILTER_MASTER: Record<string, 'models' | 'colors' | 'sizes' | 'contractors' | 'staff' | 'vendors'> = {
  modelId: 'models',
  colorId: 'colors',
  sizeId: 'sizes',
  contractorId: 'contractors',
  staffId: 'staff',
  vendorId: 'vendors',
};

const FILTER_LABEL: Record<string, string> = {
  modelId: 'Model',
  colorId: 'Color',
  sizeId: 'Size',
  contractorId: 'Contractor',
  staffId: 'Checker/Packer',
  vendorId: 'Vendor',
};

function FullReportCard() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  const base = `/api/reports/full?${qs.toString()}${qs.toString() ? '&' : ''}`;

  return (
    <section className="mb-6 rounded-2xl border border-violet-200 bg-violet-50/50 p-4 print:hidden">
      <h2 className="text-sm font-bold text-gray-900">📑 Complete Business Report</h2>
      <p className="mb-3 text-sm text-gray-600">
        Everything in one document — summary figures, charts, and all {''}
        reports together. Download as a visual report (opens in any browser, prints
        beautifully) or as an Excel workbook with one sheet per report.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="From (optional)">
          <TextInput type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To (optional)">
          <TextInput type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <a href={`${base}format=html`}>
          <Button>⬇ Visual report (HTML)</Button>
        </a>
        <a href={`${base}format=xlsx`}>
          <Button variant="secondary">⬇ Excel workbook</Button>
        </a>
      </div>
    </section>
  );
}

function renderCell(column: ReportColumn, value: unknown): string {
  if (value == null || value === '') return '—';
  switch (column.type) {
    case 'pcs':
      return formatPieces(Number(value));
    case 'cm':
      return formatCm(Number(value));
    case 'paise':
      return formatPaise(Number(value));
    case 'pct':
      return `${value}%`;
    case 'date':
      return formatBusinessDate(String(value));
    default:
      return String(value);
  }
}

export default function ReportsPage() {
  const { data: meta } = useQuery({
    queryKey: ['reports', 'meta'],
    queryFn: () => api.get<{ reports: ReportMeta[] }>('/api/reports'),
  });
  const [selectedKey, setSelectedKey] = useState('');
  const [filters, setFilters] = useState<Record<string, string | number | null>>({});

  const report = meta?.reports.find((r) => r.key === selectedKey) ?? null;
  const groups = useMemo(() => {
    const out = new Map<string, ReportMeta[]>();
    for (const r of meta?.reports ?? []) {
      out.set(r.group, [...(out.get(r.group) ?? []), r]);
    }
    return out;
  }, [meta]);

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) {
      if (v != null && v !== '') params.set(k, String(v));
    }
    return params.toString();
  }, [filters]);

  const { data: result, isLoading } = useQuery({
    queryKey: ['reports', selectedKey, queryString],
    queryFn: () =>
      api.get<{ columns: ReportColumn[]; rows: Array<Record<string, unknown>> }>(
        `/api/reports/${selectedKey}${queryString ? `?${queryString}` : ''}`,
      ),
    enabled: !!selectedKey,
  });

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4 print:hidden">
        <h1 className="text-xl font-bold text-gray-900">Reports</h1>
        <p className="text-sm text-gray-500">
          Every report can be filtered, printed and downloaded as Excel
        </p>
      </div>

      <FullReportCard />

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 print:hidden">
        <Field label="Report">
          <Select value={selectedKey} onChange={(e) => {
            setSelectedKey(e.target.value);
            setFilters({});
          }}>
            <option value="" disabled>
              — choose a report —
            </option>
            {[...groups.entries()].map(([group, reports]) => (
              <optgroup key={group} label={group}>
                {reports.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.title}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </Field>

        {report?.filters.includes('from') && (
          <Field label="From date">
            <TextInput
              type="date"
              value={(filters.from as string) ?? ''}
              onChange={(e) => setFilters({ ...filters, from: e.target.value })}
            />
          </Field>
        )}
        {report?.filters.includes('to') && (
          <Field label="To date">
            <TextInput
              type="date"
              value={(filters.to as string) ?? ''}
              onChange={(e) => setFilters({ ...filters, to: e.target.value })}
            />
          </Field>
        )}
        {report?.filters
          .filter((f) => f in FILTER_MASTER)
          .map((f) => (
            <Field key={f} label={FILTER_LABEL[f] ?? f}>
              <MasterSelect
                master={FILTER_MASTER[f]!}
                value={(filters[f] as number) ?? null}
                onChange={(id) => setFilters({ ...filters, [f]: id })}
                allowEmpty
                emptyLabel="All"
              />
            </Field>
          ))}
      </div>

      {report && (
        <div className="mb-3 flex flex-wrap items-center gap-2 print:hidden">
          <a href={`/api/reports/${report.key}?${queryString}${queryString ? '&' : ''}format=xlsx`}>
            <Button variant="secondary">⬇ Download Excel</Button>
          </a>
          <Button variant="secondary" onClick={() => window.print()}>
            🖨 Print
          </Button>
          {result && (
            <span className="ml-auto text-xs text-gray-400">{result.rows.length} rows</span>
          )}
        </div>
      )}

      {/* print header */}
      {report && (
        <div className="hidden print:block print:mb-4">
          <h1 className="text-lg font-bold">{report.title} — Bharti Enterprises</h1>
          <p className="text-xs text-gray-500">Generated {new Date().toLocaleDateString('en-IN')}</p>
        </div>
      )}

      {!report && <EmptyState title="Pick a report to begin" hint="Reports are grouped by area: inventory, production, contractors, quality, losses and management." />}
      {report && isLoading && <Spinner />}
      {report && result && result.rows.length === 0 && (
        <EmptyState title="No data for these filters" />
      )}
      {report && result && result.rows.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-gray-200 bg-white print:rounded-none print:border-0">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-400">
                {result.columns.map((c) => (
                  <th key={c.key} className="px-4 py-3 font-semibold">
                    {c.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, i) => (
                <tr key={i} className="border-b border-gray-100 last:border-0">
                  {result.columns.map((c) => (
                    <td key={c.key} className="px-4 py-2.5">
                      {renderCell(c, row[c.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
