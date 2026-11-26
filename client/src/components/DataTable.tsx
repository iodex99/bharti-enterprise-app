import { useMemo, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { EmptyState, Select, Spinner, TextInput, useIsCompact } from './ui';

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
 * One-tap status filters shown as chips above the list ("Open", "Completed", …) with
 * how many rows each holds — the filter people actually use, one thumb away.
 */
export type QuickFilter<T> = {
  key: string;
  label: string;
  test: (row: T) => boolean;
};

/** The value a column contributes to search, sorting and export. */
function columnValue<T>(col: Column<T>, row: T): unknown {
  return col.value ? col.value(row) : (row as Record<string, unknown>)[col.key];
}

/**
 * Client-side table for lists: one-tap status chips, instant search, dropdown filters
 * (facets), date-range filter, and click-to-sort headers. On a phone the dropdowns and
 * dates fold away behind one "Filters" button so the list itself stays on screen.
 * Server-paginated views (audit) manage their own.
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
  quickFilters,
  defaultQuick,
  onRowClick,
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
  quickFilters?: QuickFilter<T>[];
  /** the chip selected when the page opens ('' = All) */
  defaultQuick?: string;
  /** tapping a row/card opens it (the action buttons still work on their own) */
  onRowClick?: (row: T) => void;
}) {
  const [q, setQ] = useState('');
  const [facetValues, setFacetValues] = useState<Record<string, string>>({});
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [quick, setQuick] = useState(defaultQuick ?? '');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const compact = useIsCompact();

  const quickCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const qf of quickFilters ?? []) out[qf.key] = rows ? rows.filter(qf.test).length : 0;
    return out;
  }, [rows, quickFilters]);

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

  const filtered = useMemo(() => {
    if (!rows) return [];
    let out = rows;
    const chip = quickFilters?.find((qf) => qf.key === quick);
    if (chip) out = out.filter(chip.test);
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
  }, [
    rows,
    q,
    columns,
    facets,
    facetValues,
    dateRange,
    from,
    to,
    sortKey,
    sortDir,
    quickFilters,
    quick,
  ]);

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
  const activeFilterCount =
    Object.values(facetValues).filter(Boolean).length + (from ? 1 : 0) + (to ? 1 : 0);
  // phones: dropdowns + dates live behind one button (open by itself when in use)
  const showFilters = !compact || filtersOpen || activeFilterCount > 0;

  return (
    <div>
      {quickFilters && quickFilters.length > 0 && (
        <div
          role="group"
          aria-label="Quick filter"
          className="-mx-4 mb-2 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0"
        >
          {[{ key: '', label: 'All', test: () => true } as QuickFilter<T>, ...quickFilters].map(
            (qf) => {
              const active = quick === qf.key;
              const count = qf.key === '' ? (rows?.length ?? 0) : (quickCounts[qf.key] ?? 0);
              return (
                <button
                  key={qf.key || 'all'}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setQuick(qf.key)}
                  className={clsx(
                    'flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium sm:min-h-[34px]',
                    active
                      ? 'border-violet-600 bg-violet-600 text-white'
                      : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300',
                  )}
                >
                  {qf.label}
                  <span className={clsx('text-xs', active ? 'text-white/80' : 'text-gray-400')}>
                    {count}
                  </span>
                </button>
              );
            },
          )}
        </div>
      )}
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 sm:w-60 sm:flex-none">
          <TextInput
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label="Search"
          />
        </div>
        {compact && hasFilters && (
          <button
            type="button"
            aria-expanded={showFilters}
            onClick={() => setFiltersOpen(!filtersOpen)}
            className={clsx(
              'flex min-h-[44px] items-center gap-1 rounded-lg border px-3 text-sm font-medium',
              activeFilterCount > 0
                ? 'border-violet-400 bg-violet-50 text-violet-700'
                : 'border-gray-300 bg-white text-gray-600',
            )}
          >
            Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
          </button>
        )}
        {showFilters &&
          facets?.map((facet) => (
            <div key={facet.key} className="w-full sm:w-44">
              <Select
                aria-label={`Filter ${facet.label}`}
                value={facetValues[facet.key] ?? ''}
                onChange={(e) => setFacetValues({ ...facetValues, [facet.key]: e.target.value })}
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
        {showFilters && dateRange && (
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
        {/* Cards have no column headings to click, so phones get a sort picker —
            otherwise sorting would simply be missing on the device operators use. */}
        {compact && showFilters && (
          <div className="w-full">
            <Select
              aria-label="Sort by"
              value={sortKey ? `${sortKey}:${sortDir}` : ''}
              onChange={(e) => {
                const [key, dir] = e.target.value.split(':');
                setSortKey(key || null);
                setSortDir(dir === 'desc' ? 'desc' : 'asc');
              }}
            >
              <option value="">Sort: as listed</option>
              {columns
                .filter((c) => c.sortable !== false && c.header)
                .flatMap((c) => [
                  <option key={`${c.key}:asc`} value={`${c.key}:asc`}>
                    {c.header} ↑
                  </option>,
                  <option key={`${c.key}:desc`} value={`${c.key}:desc`}>
                    {c.header} ↓
                  </option>,
                ])}
            </Select>
          </div>
        )}
        {(q || from || to || Object.values(facetValues).some(Boolean)) && (
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

      {/*
        Phones get CARDS, not a table. A 9-column table on a 360px screen pushes the
        quantity and the action button off-screen, where an operator never finds them —
        so below `sm` every row becomes a stacked label/value card with its buttons.
        Exactly ONE of the two is rendered: a CSS-hidden copy would still be in the DOM,
        doubling every text match for screen readers and tests alike.
      */}
      {!loading && rows && rows.length > 0 && compact && (
        // role table/row/cell so a card behaves exactly like its table row
        <div className="space-y-2" role="table">
          {filtered.map((row) => (
            <div
              key={row.id}
              role="row"
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={clsx(
                'rounded-2xl border border-gray-200 bg-white p-3',
                onRowClick && 'cursor-pointer active:bg-gray-50',
              )}
            >
              <dl className="space-y-1.5">
                {columns.map((c) => {
                  const content = c.render ? c.render(row) : String(columnValue(c, row) ?? '');
                  if (content === '' || content == null) return null;
                  return (
                    <div key={c.key} className="flex items-baseline justify-between gap-3">
                      {c.header && (
                        <dt className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                          {c.header}
                        </dt>
                      )}
                      <dd role="cell" className={clsx('min-w-0 text-right text-sm', c.className)}>
                        {content}
                      </dd>
                    </div>
                  );
                })}
              </dl>
              {actions && (
                <div
                  role="cell"
                  onClick={(e) => e.stopPropagation()}
                  className="mt-2 flex flex-wrap justify-end gap-1 border-t border-gray-100 pt-2"
                >
                  {actions(row)}
                </div>
              )}
            </div>
          ))}
          {filtered.length === 0 && (
            <p className="rounded-2xl border border-gray-200 bg-white p-6 text-center text-sm text-gray-400">
              No matches for the current filters
            </p>
          )}
        </div>
      )}

      {!loading && rows && rows.length > 0 && !compact && (
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
                          // -my-2 py-2 grows the tap area into the cell padding without
                          // moving anything — header text alone is a 16px target on a phone
                          '-my-2 inline-flex items-center gap-1 py-2 uppercase tracking-wide hover:text-gray-700',
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
                <tr
                  key={row.id}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={clsx(
                    'border-b border-gray-100 last:border-0 hover:bg-gray-50/50',
                    onRowClick && 'cursor-pointer',
                  )}
                >
                  {columns.map((c) => (
                    <td key={c.key} className={clsx('px-4 py-2.5 align-middle', c.className)}>
                      {c.render ? c.render(row) : String(columnValue(c, row) ?? '')}
                    </td>
                  ))}
                  {actions && (
                    <td className="px-4 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                      <div className="flex justify-end gap-1">{actions(row)}</div>
                    </td>
                  )}
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td
                    colSpan={columns.length + (actions ? 1 : 0)}
                    className="p-6 text-center text-sm text-gray-400"
                  >
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
