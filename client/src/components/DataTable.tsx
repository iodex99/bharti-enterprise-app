import { useMemo, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { EmptyState, Spinner, TextInput } from './ui';

export type Column<T> = {
  key: string;
  header: string;
  render?: (row: T) => ReactNode;
  className?: string;
  /** dotted path or key used for the default text rendering + search */
  value?: (row: T) => unknown;
};

/**
 * Client-side table for master data and small lists: instant search, sticky header,
 * horizontal scroll on phones. Server-driven lists (reports) get their own component.
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
}: {
  columns: Column<T>[];
  rows: T[] | undefined;
  loading?: boolean;
  searchPlaceholder?: string;
  emptyTitle?: string;
  emptyHint?: string;
  actions?: (row: T) => ReactNode;
  toolbar?: ReactNode;
}) {
  const [q, setQ] = useState('');

  const filtered = useMemo(() => {
    if (!rows) return [];
    if (!q.trim()) return rows;
    const needle = q.toLowerCase();
    return rows.filter((row) =>
      columns.some((col) => {
        const v = col.value ? col.value(row) : (row as Record<string, unknown>)[col.key];
        return v != null && String(v).toLowerCase().includes(needle);
      }),
    );
  }, [rows, q, columns]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="w-full sm:w-72">
          <TextInput
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label="Search"
          />
        </div>
        {toolbar}
        {rows && (
          <span className="ml-auto text-xs text-gray-400">
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
                    {c.header}
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
                        : String(
                            (c.value ? c.value(row) : (row as Record<string, unknown>)[c.key]) ?? '',
                          )}
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
                    No matches for “{q}”
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
