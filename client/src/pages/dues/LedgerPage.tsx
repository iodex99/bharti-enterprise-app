import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  formatBusinessDate,
  formatPaise,
  formatPieces,
  label as enumLabel,
  todayIST,
} from '@shared';
import { api, ApiError } from '../../api/client';
import { useAuth } from '../../lib/auth';
import {
  Button,
  EmptyState,
  ErrorText,
  MiniTable,
  PhotoThumb,
  Spinner,
  TextInput,
} from '../../components/ui';
import { PaymentModal } from './PaymentModal';

type Kind = 'contractor' | 'staff';

type Entry = {
  date: string;
  kind: 'work' | 'check' | 'pack' | 'rework' | 'missing' | 'payment';
  docNo: string;
  ref: string;
  description: string;
  qtyPcs: number | null;
  ratePaisePerDozen: number | null;
  amountPaise: number;
  balancePaise: number;
  note: string;
};

type BreakdownRow = {
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

type Statement = {
  party: {
    kind: Kind;
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
  entries: Entry[];
};

type Period = 'all' | 'this' | 'last' | 'custom';

function monthRange(offset: number): { from: string; to: string } {
  const [y, m] = todayIST().split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + offset, 1));
  const from = d.toISOString().slice(0, 10);
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
    .toISOString()
    .slice(0, 10);
  return { from, to: offset === 0 ? todayIST() : end };
}

const ENTRY_TEXT: Record<Entry['kind'], string> = {
  work: 'Received',
  check: 'Checked',
  pack: 'Packed',
  rework: 'Sent back for rework',
  missing: 'Missing at checking',
  payment: 'Payment',
};

/**
 * One person's account (ADR-047): what they earned, what was deducted and why, what
 * was paid — and the PDF statement to send them, generated from the same numbers.
 */
export default function LedgerPage() {
  const { kind: kindParam, id: idParam } = useParams();
  const kind: Kind = kindParam === 'staff' ? 'staff' : 'contractor';
  const id = Number(idParam);
  const { user } = useAuth();
  const canPay = user?.role === 'admin' || user?.role === 'operator';
  const queryClient = useQueryClient();
  const [period, setPeriod] = useState<Period>('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [payOpen, setPayOpen] = useState(false);
  const [busy, setBusy] = useState<'' | 'download' | 'share'>('');
  const [fileError, setFileError] = useState('');

  const range =
    period === 'this'
      ? monthRange(0)
      : period === 'last'
        ? monthRange(-1)
        : period === 'custom'
          ? { from: customFrom, to: customTo }
          : { from: '', to: '' };
  const qs = new URLSearchParams();
  if (range.from) qs.set('from', range.from);
  if (range.to) qs.set('to', range.to);
  const query = qs.toString() ? `?${qs.toString()}` : '';
  const basePath = kind === 'contractor' ? `/api/contractors/${id}` : `/api/staff/${id}`;

  const {
    data: st,
    isLoading,
    error,
  } = useQuery({
    queryKey: [kind === 'contractor' ? 'contractors' : 'staff', 'statement', id, query],
    queryFn: () => api.get<Statement>(`${basePath}/statement${query}`),
    enabled: Number.isInteger(id) && id > 0,
  });

  const canShareFiles =
    typeof navigator !== 'undefined' &&
    typeof navigator.canShare === 'function' &&
    navigator.canShare({ files: [new File([''], 'x.pdf', { type: 'application/pdf' })] });

  const getPdf = async (mode: 'download' | 'share') => {
    setFileError('');
    setBusy(mode);
    try {
      const { blob, fileName } = await api.file(`${basePath}/statement/pdf${query}`);
      const file = new File([blob], fileName, { type: 'application/pdf' });
      if (mode === 'share' && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: `Statement — ${st?.party.name ?? ''}` });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      }
    } catch (err) {
      // the user closing the share sheet is not an error
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setFileError(err instanceof ApiError ? err.message : 'Could not make the PDF. Try again.');
    } finally {
      setBusy('');
    }
  };

  if (isLoading || !st) {
    return (
      <div className="p-4 sm:p-6">
        <BackLink kind={kind} />
        {error ? (
          <ErrorText>
            {error instanceof ApiError ? error.message : 'Could not load this ledger.'}
          </ErrorText>
        ) : (
          <Spinner />
        )}
      </div>
    );
  }

  const t = st.totals;
  const due = t.closingBalancePaise;
  const isContractor = kind === 'contractor';

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <BackLink kind={kind} />

      {/* who + what is owed */}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-gray-200 bg-white p-4">
        <div className="flex min-w-0 items-center gap-3">
          {st.party.imagePath && (
            <PhotoThumb
              src={st.party.imagePath}
              title={`${st.party.name} — payment QR`}
              size={56}
            />
          )}
          <div className="min-w-0">
            <h1 className="truncate text-xl font-bold text-gray-900">{st.party.name}</h1>
            <p className="text-sm text-gray-500">
              {isContractor ? 'Contractor' : 'Checker / Packer'}
              {st.party.mobile && (
                <>
                  {' · '}
                  <a href={`tel:${st.party.mobile}`} className="text-violet-700 hover:underline">
                    {st.party.mobile}
                  </a>
                </>
              )}
            </p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
            {due >= 0 ? 'Balance due' : 'Paid in advance'}
            {(st.period.from || st.period.to) && ' (end of period)'}
          </p>
          <p
            className={clsx(
              'text-2xl font-bold',
              due > 0 ? 'text-amber-700' : due < 0 ? 'text-blue-700' : 'text-gray-500',
            )}
          >
            {formatPaise(Math.abs(due))}
          </p>
        </div>
      </div>

      {/* the three things people do here */}
      <div className="mb-4 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        {canPay && (
          <Button onClick={() => setPayOpen(true)} className="col-span-2 sm:col-span-1">
            Record payment
          </Button>
        )}
        <Button variant="secondary" disabled={!!busy} onClick={() => void getPdf('download')}>
          {busy === 'download' ? 'Preparing…' : '⬇ Download PDF'}
        </Button>
        {canShareFiles ? (
          <Button variant="secondary" disabled={!!busy} onClick={() => void getPdf('share')}>
            {busy === 'share' ? 'Preparing…' : '↗ Share PDF'}
          </Button>
        ) : (
          <span />
        )}
      </div>
      <ErrorText>{fileError}</ErrorText>

      {/* period */}
      <div className="mb-4">
        <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
          {(
            [
              ['all', 'All time'],
              ['this', 'This month'],
              ['last', 'Last month'],
              ['custom', 'Choose dates'],
            ] as Array<[Period, string]>
          ).map(([key, text]) => (
            <button
              key={key}
              aria-pressed={period === key}
              onClick={() => setPeriod(key)}
              className={clsx(
                'min-h-[40px] shrink-0 rounded-full border px-3.5 text-sm font-medium',
                period === key
                  ? 'border-violet-600 bg-violet-600 text-white'
                  : 'border-gray-200 bg-white text-gray-600',
              )}
            >
              {text}
            </button>
          ))}
        </div>
        {period === 'custom' && (
          <div className="mt-2 flex items-center gap-2">
            <TextInput
              type="date"
              aria-label="From"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
            />
            <span className="text-sm text-gray-400">to</span>
            <TextInput
              type="date"
              aria-label="To"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
            />
          </div>
        )}
      </div>

      {/* how the number was worked out */}
      <section className="mb-5 rounded-2xl border border-violet-200 bg-violet-50/40 p-4">
        <h2 className="mb-3 text-sm font-bold text-gray-900">How this is worked out</h2>
        <dl className="space-y-2 text-sm">
          {st.period.from && (
            <Line label="Opening balance (before this period)" value={st.openingBalancePaise} />
          )}
          <Line
            label={
              <>
                {isContractor ? 'Work received' : 'Work done'}:{' '}
                <strong>{formatPieces(t.workPcs)}</strong>
              </>
            }
            value={t.earnedPaise}
            sign="+"
          />
          {t.reworkPcs > 0 && (
            <Line
              label={
                <>
                  Sent back for rework: <strong>{formatPieces(t.reworkPcs)}</strong>
                  <span className="block text-xs text-gray-500">
                    paid again when the fixed pieces pass checking
                  </span>
                </>
              }
              value={-t.reworkPaise}
              sign="−"
            />
          )}
          {t.missingPcs > 0 && (
            <Line
              label={
                <>
                  Missing at checking: <strong>{formatPieces(t.missingPcs)}</strong>
                </>
              }
              value={-t.missingPaise}
              sign="−"
            />
          )}
          <Line label="Paid" value={-t.paidPaise} sign="−" />
          <div className="border-t border-violet-200 pt-2">
            <Line
              label={<strong>{due >= 0 ? 'Balance due' : 'Paid in advance'}</strong>}
              value={Math.abs(due)}
              strong
            />
          </div>
        </dl>
        <p className="mt-3 text-xs text-gray-500">
          Amount = pieces × rate per dozen ÷ 12, rounded once per job.
        </p>
      </section>

      {/* per job / per batch */}
      <section className="mb-5">
        <h2 className="mb-2 text-sm font-bold text-gray-900">
          {isContractor ? 'By job card' : 'By batch'}
        </h2>
        {st.breakdown.length === 0 ? (
          <EmptyState title="No work in this period" />
        ) : (
          <MiniTable
            rows={st.breakdown}
            keyOf={(b) => `${b.ref}|${b.item}|${b.ratePaisePerDozen}`}
            minWidth={isContractor ? 720 : 520}
            columns={[
              {
                header: isContractor ? 'Job' : 'Doc',
                className: 'font-mono text-xs',
                render: (b) => b.ref,
              },
              { header: 'Item', className: 'font-medium', render: (b) => b.item },
              { header: 'Rate/dz', render: (b) => formatPaise(b.ratePaisePerDozen) },
              {
                header: isContractor ? 'Received' : 'Pieces',
                render: (b) => formatPieces(b.workPcs),
              },
              ...(isContractor
                ? [
                    {
                      header: 'Rework',
                      className: 'text-red-700',
                      render: (b: BreakdownRow) =>
                        b.reworkPcs ? `−${formatPieces(b.reworkPcs)}` : '—',
                    },
                    {
                      header: 'Missing',
                      className: 'text-red-700',
                      render: (b: BreakdownRow) =>
                        b.missingPcs ? `−${formatPieces(b.missingPcs)}` : '—',
                    },
                    { header: 'Payable', render: (b: BreakdownRow) => formatPieces(b.netPcs) },
                  ]
                : []),
              {
                header: 'Amount',
                className: 'font-semibold',
                render: (b) => formatPaise(b.amountPaise),
              },
            ]}
          />
        )}
      </section>

      {/* every movement, oldest first, with the running balance */}
      <section>
        <h2 className="mb-2 text-sm font-bold text-gray-900">Account ledger</h2>
        {st.entries.length === 0 ? (
          <EmptyState title="Nothing in this period" />
        ) : (
          <MiniTable
            rows={st.entries}
            keyOf={(e) =>
              `${e.kind}-${e.docNo}-${e.date}-${e.description}-${e.qtyPcs}-${e.balancePaise}`
            }
            minWidth={680}
            columns={[
              {
                header: 'Date',
                className: 'whitespace-nowrap text-gray-500',
                render: (e) => formatBusinessDate(e.date),
              },
              {
                header: 'Particulars',
                render: (e) => (
                  <span className="text-left">
                    <span className="font-medium">{ENTRY_TEXT[e.kind]}</span>{' '}
                    {e.kind === 'payment' ? (
                      <span className="text-gray-500">
                        {enumLabel(e.description)}
                        {e.ref && ` · ${e.ref}`}
                      </span>
                    ) : (
                      <span className="text-gray-600">
                        {e.description} · {formatPieces(Math.abs(e.qtyPcs ?? 0))}
                        {e.kind === 'rework' && e.note && (
                          <span className="text-xs text-gray-400"> ({enumLabel(e.note)})</span>
                        )}
                      </span>
                    )}
                  </span>
                ),
              },
              {
                header: 'Doc',
                className: 'font-mono text-xs text-gray-400',
                render: (e) => e.docNo,
              },
              {
                header: 'Amount',
                className: 'whitespace-nowrap font-semibold',
                render: (e) => (
                  <span className={e.amountPaise >= 0 ? 'text-emerald-700' : 'text-red-700'}>
                    {e.amountPaise >= 0 ? '+' : '−'}
                    {formatPaise(Math.abs(e.amountPaise))}
                  </span>
                ),
              },
              {
                header: 'Balance',
                className: 'whitespace-nowrap',
                render: (e) => formatPaise(e.balancePaise),
              },
            ]}
          />
        )}
      </section>

      {payOpen && (
        <PaymentModal
          payee={{ kind, id, name: st.party.name, duesPaise: due, imagePath: st.party.imagePath }}
          onClose={() => setPayOpen(false)}
          onDone={() => {
            void queryClient.invalidateQueries({ queryKey: ['contractors'] });
            void queryClient.invalidateQueries({ queryKey: ['staff'] });
          }}
        />
      )}
    </div>
  );
}

function Line({
  label,
  value,
  sign,
  strong,
}: {
  label: ReactNode;
  value: number;
  sign?: '+' | '−';
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-gray-700">{label}</dt>
      <dd
        className={clsx(
          'whitespace-nowrap',
          strong ? 'text-lg font-bold text-gray-900' : 'font-medium',
        )}
      >
        {sign === '−' && value !== 0 ? '−' : ''}
        {formatPaise(Math.abs(value))}
      </dd>
    </div>
  );
}

function BackLink({ kind }: { kind: Kind }) {
  return (
    <Link
      to={`/dues?tab=${kind === 'contractor' ? 'contractors' : 'staff'}`}
      className="mb-3 inline-flex min-h-[40px] items-center text-sm font-medium text-violet-700 hover:underline"
    >
      ← Pending Dues
    </Link>
  );
}
