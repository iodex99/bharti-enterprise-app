import { useMemo, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { EmptyState, Select, Spinner, TextInput } from './ui';

export type Column<T> = {
  key: string;
  header: string;
  render?: (row: T) => ReactNode;
  className?: string;
  /** value used for search, SORTING and export — defaults to row[key] */
  value?: (row: T) => unknown;
  /** opt out of sorting for purely visual columns */
  sortable?: boolean;
};

export type Facet<T> = {
  key: string;
  label: string;
  /** the value a row contributes to this facet (null/undefined rows always pass) */
  value: (row: T) => string | null | undefined;
};

export type DateRange<T> = {
  label: string;
  /** must return a YYYY-MM-DD business date */
  value: (row: T) => string;
};

/**
 * Client-side table for lists: instant search, dropdown filters (facets), date-range
 * filter, and click-to-sort headers. Server-paginated views (audit) manage their own.
 */
export function DataTable<T extends { id: number | string }>({
  columns,
  rows,
  loading,
  searchPlaceholder = 'Search…',
  emptyTitle = 'Nothing here yet',
  emptyHint,
  actions,
  toolbar,
  facets,
  dateRange,
}: {
  columns: Column<T>[];
  rows: T[] | undefined;
  loading?: boolean;
  searchPlaceholder?: string;
  emptyTitle?: string;
  emptyHint?: string;
  actions?: (row: T) => ReactNode;
  toolbar?: ReactNode;
  facets?: Facet<T>[];
  dateRange?: DateRange<T>;
}) {
  const [q, setQ] = useState('');
  const [facetValues, setFacetValues] = useState<Record<string, string>>({});
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const facetOptions = useMemo(() => {
    const out: Record<string, string[]> = {};
    if (!rows || !facets) return out;
    for (const facet of facets) {
      const values = new Set<string>();
      for (const row of rows) {
        const v = facet.value(row);
        if (v != null && v !== '') values.add(v);
      }
      out[facet.key] = [...values].sort((a, b) => a.localeCompare(b));
    }
    return out;
  }, [rows, facets]);

  const columnValue = (col: Column<T>, row: T): unknown =>
    col.value ? col.value(row) : (row as Record<string, unknown>)[col.key];

  const filtered = useMemo(() => {
    if (!rows) return [];
    let out = rows;
    for (const facet of facets ?? []) {
      const wanted = facetValues[facet.key];
      if (wanted) out = out.filter((row) => facet.value(row) === wanted);
    }
    if (dateRange && (from || to)) {
      out = out.filter((row) => {
        const d = dateRange.value(row);
        return (!from || d >= from) && (!to || d <= to);
      });
    }
    if (q.trim()) {
      const needle = q.toLowerCase();
      out = out.filter((row) =>
        columns.some((col) => {
          const v = columnValue(col, row);
          return v != null && String(v).toLowerCase().includes(needle);
        }),
      );
    }
    if (sortKey) {
      const col = columns.find((c) => c.key === sortKey);
      if (col) {
        out = [...out].sort((a, b) => {
          const va = columnValue(col, a);
          const vb = columnValue(col, b);
          if (va == null && vb == null) return 0;
          if (va == null) return 1;
          if (vb == null) return -1;
          const cmp =
            typeof va === 'number' && typeof vb === 'number'
              ? va - vb
              : String(va).localeCompare(String(vb), undefined, { numeric: true });
          return sortDir === 'asc' ? cmp : -cmp;
        });
      }
    }
    return out;
  }, [rows, q, columns, facets, facetValues, dateRange, from, to, sortKey, sortDir]);

  const toggleSort = (col: Column<T>) => {
    if (col.sortable === false) return;
    if (sortKey !== col.key) {
      setSortKey(col.key);
      setSortDir('asc');
    } else if (sortDir === 'asc') {
      setSortDir('desc');
    } else {
      setSortKey(null);
    }
  };

  const hasFilters = (facets?.length ?? 0) > 0 || !!dateRange;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <div className="w-full sm:w-60">
          <TextInput
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label="Search"
          />
        </div>
        {facets?.map((facet) => (
          <div key={facet.key} className="w-full sm:w-44">
            <Select
              aria-label={`Filter ${facet.label}`}
              value={facetValues[facet.key] ?? ''}
              onChange={(e) =>
                setFacetValues({ ...facetValues, [facet.key]: e.target.value })
              }
            >
              <option value="">{facet.label}: all</option>
              {(facetOptions[facet.key] ?? []).map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </Select>
          </div>
        ))}
        {dateRange && (
          <>
            <div className="w-[9.5rem]">
              <TextInput
                type="date"
                aria-label={`Filter ${dateRange.label} from`}
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <span className="pb-2 text-xs text-gray-400">to</span>
            <div className="w-[9.5rem]">
              <TextInput
                type="date"
                aria-label={`Filter ${dateRange.label} to`}
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
          </>
        )}
        {hasFilters && (q || from || to || Object.values(facetValues).some(Boolean)) && (
          <button
            className="pb-2 text-xs font-medium text-violet-600 hover:underline"
            onClick={() => {
              setQ('');
              setFacetValues({});
              setFrom('');
              setTo('');
            }}
          >
            Clear filters
          </button>
        )}
        {toolbar}
        {rows && (
          <span className="ml-auto pb-2 text-xs text-gray-400">
            {filtered.length} of {rows.length}
          </span>
        )}
      </div>

      {loading && (
        <div className="flex justify-center p-10">
          <Spinner />
        </div>
      )}
      {!loading && rows && rows.length === 0 && <EmptyState title={emptyTitle} hint={emptyHint} />}
      {!loading && rows && rows.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-gray-200 bg-white">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="sticky top-0 bg-white">
              <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-400">
                {columns.map((c) => (
                  <th key={c.key} className={clsx('px-4 py-3 font-semibold', c.className)}>
                    {c.sortable === false ? (
                      c.header
                    ) : (
                      <button
                        className={clsx(
                          'inline-flex items-center gap-1 uppercase tracking-wide hover:text-gray-700',
                          sortKey === c.key && 'text-violet-700',
                        )}
                        onClick={() => toggleSort(c)}
                        title={`Sort by ${c.header}`}
                      >
                        {c.header}
                        <span aria-hidden className="text-[10px]">
                          {sortKey === c.key ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}
                        </span>
                      </button>
                    )}
                  </th>
                ))}
                {actions && <th className="px-4 py-3 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr key={row.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50/50">
                  {columns.map((c) => (
                    <td key={c.key} className={clsx('px-4 py-2.5 align-middle', c.className)}>
                      {c.render
                        ? c.render(row)
                        : String(columnValue(c, row) ?? '')}
                    </td>
                  ))}
                  {actions && (
                    <td className="px-4 py-2.5 text-right">
                      <div className="flex justify-end gap-1">{actions(row)}</div>
                    </td>
                  )}
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={columns.length + (actions ? 1 : 0)} className="p-6 text-center text-sm text-gray-400">
                    No matches for the current filters
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
