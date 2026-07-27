import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  useEffect,
  useSyncExternalStore,
} from 'react';
import clsx from 'clsx';

/** Tailwind's `sm`. Below it, lists render as cards (ADR-038). */
const COMPACT = '(max-width: 639.98px)';

function subscribeToWidth(onChange: () => void): () => void {
  const mq = window.matchMedia(COMPACT);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

/**
 * True on phone-width screens. Lists SWAP their markup on this rather than rendering
 * both and hiding one with CSS: a hidden copy still sits in the DOM, where it doubles
 * every text match (and every row a test or a screen reader can find).
 */
export function useIsCompact(): boolean {
  return useSyncExternalStore(subscribeToWidth, () => window.matchMedia(COMPACT).matches);
}

export function Button({
  variant = 'primary',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
}) {
  return (
    <button
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'primary' && 'bg-violet-600 text-white hover:bg-violet-700',
        variant === 'secondary' && 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50',
        variant === 'danger' && 'bg-red-600 text-white hover:bg-red-700',
        variant === 'ghost' && 'text-gray-600 hover:bg-gray-100',
        className,
      )}
      {...props}
    />
  );
}

/**
 * A small list that is a TABLE on a laptop and CARDS on a phone. Operators work on
 * phones, where a wide table pushes the quantity and the action button off-screen —
 * so below `sm` each row stacks into label/value pairs with its buttons underneath.
 */
export function MiniTable<T>({
  rows,
  keyOf,
  columns,
  actions,
  actionHeader = 'Action',
  minWidth = 640,
}: {
  rows: T[];
  keyOf: (row: T) => string | number;
  columns: Array<{ header: string; render: (row: T) => ReactNode; className?: string }>;
  actions?: (row: T) => ReactNode;
  actionHeader?: string;
  minWidth?: number;
}) {
  // role table/row/cell so a card is the same thing as its table row to a screen
  // reader — and to a test, which then describes ONE list rather than two
  if (useIsCompact()) {
    return (
      <div className="space-y-2" role="table">
        {rows.map((row) => (
          <div key={keyOf(row)} role="row" className="rounded-xl border border-gray-200 bg-white p-3">
            <dl className="space-y-1.5">
              {columns.map((c) => (
                <div key={c.header} className="flex items-baseline justify-between gap-3">
                  <dt className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                    {c.header}
                  </dt>
                  <dd role="cell" className={clsx('min-w-0 text-right text-sm', c.className)}>
                    {c.render(row)}
                  </dd>
                </div>
              ))}
            </dl>
            {actions && (
              <div
                role="cell"
                className="mt-2 flex flex-wrap justify-end gap-1 border-t border-gray-100 pt-2"
              >
                {actions(row)}
              </div>
            )}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
      <table className="w-full text-sm" style={{ minWidth }}>
        <thead>
          <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-400">
            {columns.map((c) => (
              <th key={c.header} className="px-3 py-2">
                {c.header}
              </th>
            ))}
            {actions && <th className="px-3 py-2 text-right">{actionHeader}</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={keyOf(row)} className="border-b border-gray-100 last:border-0">
              {columns.map((c) => (
                <td key={c.header} className={clsx('px-3 py-2', c.className)}>
                  {c.render(row)}
                </td>
              ))}
              {actions && <td className="px-3 py-2 text-right">{actions(row)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A link to a photo or QR code. Operators work on phones, so these never render as a
 * bare emoji — every one gets a finger-sized (36px) hit area of its own.
 */
export function ThumbLink({
  href,
  icon = '📷',
  label,
  title,
}: {
  href: string;
  icon?: string;
  label?: string;
  title?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={title ?? label ?? 'Open photo'}
      onClick={(e) => e.stopPropagation()}
      className="inline-flex min-h-[36px] min-w-[36px] items-center justify-center gap-1 rounded-lg px-1.5 text-sm text-violet-600 hover:bg-violet-50 hover:underline"
    >
      <span aria-hidden>{icon}</span>
      {label && <span>{label}</span>}
    </a>
  );
}

export function Field({
  label,
  error,
  children,
  hint,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  // hint/error live OUTSIDE the <label> so the control's accessible name is exactly `label`.
  return (
    <div>
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-gray-700">{label}</span>
        {children}
      </label>
      {hint && !error && <span className="mt-1 block text-xs text-gray-400">{hint}</span>}
      {error && <span className="mt-1 block text-xs text-red-600">{error}</span>}
    </div>
  );
}

export function TextInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={clsx(
        'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-200 disabled:bg-gray-50',
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={clsx(
        'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-200',
        className,
      )}
      {...props}
    />
  );
}

export function Badge({
  tone = 'gray',
  children,
}: {
  tone?: 'gray' | 'green' | 'red' | 'amber' | 'violet' | 'blue';
  children: ReactNode;
}) {
  const tones = {
    gray: 'bg-gray-100 text-gray-700',
    green: 'bg-emerald-100 text-emerald-700',
    red: 'bg-red-100 text-red-700',
    amber: 'bg-amber-100 text-amber-800',
    violet: 'bg-violet-100 text-violet-700',
    blue: 'bg-sky-100 text-sky-700',
  };
  return (
    <span className={clsx('inline-block rounded-full px-2 py-0.5 text-xs font-medium', tones[tone])}>
      {children}
    </span>
  );
}

export function Modal({
  title,
  open,
  onClose,
  children,
  wide,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-label={title}
        className={clsx(
          'max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 shadow-2xl sm:rounded-2xl',
          wide ? 'sm:max-w-3xl' : 'sm:max-w-md',
        )}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-full p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-label="Loading"
      className={clsx(
        'inline-block h-5 w-5 animate-spin rounded-full border-2 border-violet-600 border-t-transparent',
        className,
      )}
    />
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-8 text-center">
      <p className="text-sm font-medium text-gray-600">{title}</p>
      {hint && <p className="mt-1 text-xs text-gray-400">{hint}</p>}
    </div>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{children}</p>;
}
