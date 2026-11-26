import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatBusinessDate, formatPaise, formatPieces, label as enumLabel } from '@shared';
import { api } from '../../api/client';
import { useAuth } from '../../lib/auth';
import { DataTable } from '../../components/DataTable';
import { Badge, Button, PageHeader, PhotoThumb, Tabs } from '../../components/ui';
import { VoidModal } from '../purchases/PurchasesPage';
import { ContractorPerformance } from '../contractors/ContractorsPage';
import { PaymentModal, type ExistingPayment, type Payee } from './PaymentModal';

type ContractorDue = {
  contractorId: number;
  name: string;
  mobile: string;
  imagePath: string | null;
  jobWorkCostPaise: number;
  paidPaise: number;
  duesPaise: number;
  lastPaymentDate: string | null;
  openJobs: number;
};

type StaffRow = {
  id: number;
  name: string;
  mobile: string;
  imagePath: string | null;
  checkedPcs: number;
  packedPcs: number;
  earnedPaise: number;
  paidPaise: number;
  duesPaise: number;
  lastPaymentDate: string | null;
};

type PaymentRow = {
  id: number;
  docNo: string;
  paymentDate: string;
  amountPaise: number;
  mode: string;
  reference: string;
  notes: string;
  voidedAt: string | null;
  contractorId?: number;
  contractorName?: string;
  staffId?: number;
  staffName?: string;
};

type Tab = 'pending' | 'contractors' | 'staff' | 'payments';

/**
 * Pending Dues (ADR-036/047): who is owed what right now, the contractors' performance,
 * checkers & packers, and every payment. Tap anyone to open their ledger — how their
 * amount was worked out, with a PDF statement to send them.
 */
export default function DuesPage() {
  const { user } = useAuth();
  const canPay = user?.role === 'admin' || user?.role === 'operator';
  const isAdmin = user?.role === 'admin';
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = (
    ['pending', 'contractors', 'staff', 'payments'].includes(params.get('tab') ?? '')
      ? params.get('tab')
      : 'pending'
  ) as Tab;
  const setTab = (t: Tab) => setParams({ tab: t }, { replace: true });
  const [payFor, setPayFor] = useState<Payee | null>(null);
  const [editPayment, setEditPayment] = useState<{ payee: Payee; payment: ExistingPayment } | null>(
    null,
  );
  const [voidFor, setVoidFor] = useState<{ id: number; label: string; url: string } | null>(null);

  const { data: contractorDues, isLoading } = useQuery({
    queryKey: ['contractors', 'dues'],
    queryFn: () =>
      api.get<{ items: ContractorDue[]; totalDuesPaise: number }>('/api/contractors/dues'),
  });
  const { data: staff, isLoading: staffLoading } = useQuery({
    queryKey: ['staff', 'analytics'],
    queryFn: () => api.get<{ items: StaffRow[] }>('/api/staff/analytics'),
  });
  const { data: cPayments } = useQuery({
    queryKey: ['contractors', 'payments'],
    queryFn: () => api.get<{ items: PaymentRow[] }>('/api/contractors/payments'),
    enabled: tab === 'payments',
  });
  const { data: sPayments } = useQuery({
    queryKey: ['staff', 'payments'],
    queryFn: () => api.get<{ items: PaymentRow[] }>('/api/staff/payments'),
    enabled: tab === 'payments',
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['contractors'] });
    void queryClient.invalidateQueries({ queryKey: ['staff'] });
  };

  const contractorRows = contractorDues?.items.map((r) => ({ ...r, id: r.contractorId }));
  const staffDueRows = staff?.items
    .filter((r) => r.duesPaise > 0)
    .sort((a, b) => b.duesPaise - a.duesPaise);
  const staffTotal = staffDueRows?.reduce((s, r) => s + r.duesPaise, 0) ?? 0;
  const total = (contractorDues?.totalDuesPaise ?? 0) + staffTotal;

  const payments = [
    ...(cPayments?.items ?? []).map((p) => ({
      ...p,
      key: `c-${p.id}`,
      kind: 'contractor' as const,
      name: p.contractorName ?? '',
      personId: p.contractorId!,
    })),
    ...(sPayments?.items ?? []).map((p) => ({
      ...p,
      key: `s-${p.id}`,
      kind: 'staff' as const,
      name: p.staffName ?? '',
      personId: p.staffId!,
    })),
  ]
    .sort((a, b) => b.paymentDate.localeCompare(a.paymentDate) || b.id - a.id)
    .map((p) => ({ ...p, paymentId: p.id, id: p.key }));

  const qr = (path: string | null, name: string) =>
    path ? (
      <PhotoThumb src={path} title={`${name} — payment QR`} size={32} />
    ) : (
      <span className="text-gray-300">—</span>
    );
  const ledger = (kind: 'contractor' | 'staff', id: number) => navigate(`/dues/${kind}/${id}`);

  return (
    <div className="p-4 sm:p-6">
      <PageHeader
        title="Pending Dues"
        subtitle="Who is owed what — tap anyone to see how it was worked out and send their statement"
        action={
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-right">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">
              Total pending
            </p>
            <p className="text-lg font-bold text-amber-900">
              {contractorDues && staff ? formatPaise(total) : '…'}
            </p>
          </div>
        }
      />

      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          {
            key: 'pending',
            label: '💰 Pending',
            count: (contractorRows?.length ?? 0) + (staffDueRows?.length ?? 0),
            tone: 'amber',
          },
          { key: 'contractors', label: '🧵 Contractors' },
          { key: 'staff', label: '✅ Checkers & Packers' },
          { key: 'payments', label: '🧾 Payments' },
        ]}
      />

      {tab === 'pending' && (
        <>
          <section className="mb-6">
            <h2 className="mb-2 text-sm font-bold text-gray-900">🧵 Contractors (stitching)</h2>
            <DataTable
              columns={[
                {
                  key: 'name',
                  header: 'Contractor',
                  className: 'font-medium',
                },
                {
                  key: 'duesPaise',
                  header: 'Pending dues',
                  className: 'font-bold',
                  render: (r) => <span className="text-amber-800">{formatPaise(r.duesPaise)}</span>,
                  value: (r) => r.duesPaise,
                },
                {
                  key: 'jobWorkCostPaise',
                  header: 'Job-work cost',
                  render: (r) => formatPaise(r.jobWorkCostPaise),
                  value: (r) => r.jobWorkCostPaise,
                },
                {
                  key: 'paidPaise',
                  header: 'Paid',
                  render: (r) => formatPaise(r.paidPaise),
                  value: (r) => r.paidPaise,
                },
                {
                  key: 'lastPaymentDate',
                  header: 'Last payment',
                  render: (r) => (r.lastPaymentDate ? formatBusinessDate(r.lastPaymentDate) : '—'),
                  value: (r) => r.lastPaymentDate ?? '',
                },
                {
                  key: 'openJobs',
                  header: 'Open jobs',
                  render: (r) => (r.openJobs > 0 ? <Badge tone="amber">{r.openJobs}</Badge> : '—'),
                  value: (r) => r.openJobs,
                },
                {
                  key: 'imagePath',
                  header: 'QR',
                  sortable: false,
                  value: () => '',
                  render: (r) => qr(r.imagePath, r.name),
                },
              ]}
              rows={contractorRows}
              loading={isLoading}
              emptyTitle="No contractor dues"
              emptyHint="Every contractor is fully paid up."
              onRowClick={(row) => ledger('contractor', row.contractorId)}
              actions={(row) => (
                <>
                  <Button variant="ghost" onClick={() => ledger('contractor', row.contractorId)}>
                    Ledger
                  </Button>
                  {canPay && (
                    <Button
                      variant="ghost"
                      className="text-emerald-700"
                      onClick={() =>
                        setPayFor({
                          kind: 'contractor',
                          id: row.contractorId,
                          name: row.name,
                          duesPaise: row.duesPaise,
                          imagePath: row.imagePath,
                        })
                      }
                    >
                      Record payment
                    </Button>
                  )}
                </>
              )}
            />
          </section>

          <section>
            <h2 className="mb-2 text-sm font-bold text-gray-900">
              ✅ Checkers &amp; packers (per-dozen pay)
            </h2>
            <StaffTable
              rows={staffDueRows}
              loading={staffLoading}
              emptyTitle="No checker/packer dues"
              emptyHint="Set each person's rate per dozen in Masters → Checkers & Packers; their pay accrues as they check and pack."
              canPay={canPay}
              onLedger={(id) => ledger('staff', id)}
              onPay={(r) =>
                setPayFor({
                  kind: 'staff',
                  id: r.id,
                  name: r.name,
                  duesPaise: r.duesPaise,
                  imagePath: r.imagePath,
                })
              }
              qr={qr}
            />
          </section>
        </>
      )}

      {tab === 'contractors' && <ContractorPerformance onOpen={(id) => ledger('contractor', id)} />}

      {tab === 'staff' && (
        <StaffTable
          rows={staff?.items}
          loading={staffLoading}
          emptyTitle="No checkers or packers yet"
          emptyHint="Add them in Masters → Checkers & Packers."
          canPay={canPay}
          onLedger={(id) => ledger('staff', id)}
          onPay={(r) =>
            setPayFor({
              kind: 'staff',
              id: r.id,
              name: r.name,
              duesPaise: r.duesPaise,
              imagePath: r.imagePath,
            })
          }
          qr={qr}
        />
      )}

      {tab === 'payments' && (
        <DataTable
          columns={[
            {
              key: 'paymentDate',
              header: 'Date',
              render: (r) => formatBusinessDate(r.paymentDate),
              value: (r) => r.paymentDate,
            },
            { key: 'name', header: 'Paid to', className: 'font-medium' },
            {
              key: 'amountPaise',
              header: 'Amount',
              className: 'font-semibold',
              render: (r) =>
                r.voidedAt ? <Badge tone="red">voided</Badge> : formatPaise(r.amountPaise),
              value: (r) => r.amountPaise,
            },
            {
              key: 'mode',
              header: 'Mode',
              render: (r) => enumLabel(r.mode),
              value: (r) => enumLabel(r.mode),
            },
            { key: 'reference', header: 'Reference', className: 'text-gray-500' },
            { key: 'docNo', header: 'Doc', className: 'font-mono text-xs text-gray-400' },
          ]}
          rows={payments}
          emptyTitle="No payments recorded"
          quickFilters={[
            {
              key: 'contractor',
              label: 'Contractors',
              test: (r) => r.kind === 'contractor' && !r.voidedAt,
            },
            {
              key: 'staff',
              label: 'Checkers & packers',
              test: (r) => r.kind === 'staff' && !r.voidedAt,
            },
            { key: 'voided', label: 'Voided', test: (r) => !!r.voidedAt },
          ]}
          facets={[
            { key: 'person', label: 'Paid to', value: (r) => r.name },
            { key: 'mode', label: 'Mode', value: (r) => enumLabel(r.mode) },
          ]}
          dateRange={{ label: 'Payment date', value: (r) => r.paymentDate }}
          onRowClick={(r) => ledger(r.kind, r.personId)}
          actions={
            isAdmin
              ? (row) =>
                  row.voidedAt ? null : (
                    <>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          const dues =
                            row.kind === 'contractor'
                              ? (contractorDues?.items.find((c) => c.contractorId === row.personId)
                                  ?.duesPaise ?? 0)
                              : (staff?.items.find((s) => s.id === row.personId)?.duesPaise ?? 0);
                          setEditPayment({
                            payee: {
                              kind: row.kind,
                              id: row.personId,
                              name: row.name,
                              duesPaise: dues,
                              imagePath: null,
                            },
                            payment: { ...row, id: row.paymentId },
                          });
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        className="text-red-600"
                        onClick={() =>
                          setVoidFor({
                            id: row.paymentId,
                            label: row.docNo,
                            url: `${row.kind === 'contractor' ? '/api/contractors' : '/api/staff'}/payments/${row.paymentId}/void`,
                          })
                        }
                      >
                        Void
                      </Button>
                    </>
                  )
              : undefined
          }
        />
      )}

      <PaymentModal
        key={payFor ? `${payFor.kind}-${payFor.id}` : 'none'}
        payee={payFor}
        onClose={() => setPayFor(null)}
        onDone={invalidate}
      />
      {editPayment && (
        <PaymentModal
          key={`edit-${editPayment.payee.kind}-${editPayment.payment.id}`}
          payee={editPayment.payee}
          existing={editPayment.payment}
          onClose={() => setEditPayment(null)}
          onDone={invalidate}
        />
      )}
      <VoidModal
        entity="payment"
        target={voidFor}
        onClose={() => setVoidFor(null)}
        onDone={invalidate}
      />
    </div>
  );
}

function StaffTable({
  rows,
  loading,
  emptyTitle,
  emptyHint,
  canPay,
  onLedger,
  onPay,
  qr,
}: {
  rows: StaffRow[] | undefined;
  loading: boolean;
  emptyTitle: string;
  emptyHint: string;
  canPay: boolean;
  onLedger: (id: number) => void;
  onPay: (row: StaffRow) => void;
  qr: (path: string | null, name: string) => React.ReactNode;
}) {
  return (
    <DataTable
      columns={[
        { key: 'name', header: 'Name', className: 'font-medium' },
        {
          key: 'duesPaise',
          header: 'Pending dues',
          className: 'font-bold',
          render: (r) =>
            r.duesPaise > 0 ? (
              <span className="text-amber-800">{formatPaise(r.duesPaise)}</span>
            ) : r.duesPaise < 0 ? (
              <span className="text-blue-700">{formatPaise(-r.duesPaise)} advance</span>
            ) : (
              <span className="text-gray-400">{formatPaise(0)}</span>
            ),
          value: (r) => r.duesPaise,
        },
        {
          key: 'work',
          header: 'Work done',
          render: (r) => (
            <span className="text-gray-600">
              {r.checkedPcs > 0 && <>checked {formatPieces(r.checkedPcs)}</>}
              {r.checkedPcs > 0 && r.packedPcs > 0 && ' · '}
              {r.packedPcs > 0 && <>packed {formatPieces(r.packedPcs)}</>}
              {r.checkedPcs + r.packedPcs === 0 && '—'}
            </span>
          ),
          value: (r) => r.checkedPcs + r.packedPcs,
        },
        {
          key: 'earnedPaise',
          header: 'Earned',
          render: (r) => formatPaise(r.earnedPaise),
          value: (r) => r.earnedPaise,
        },
        {
          key: 'paidPaise',
          header: 'Paid',
          render: (r) => formatPaise(r.paidPaise),
          value: (r) => r.paidPaise,
        },
        {
          key: 'lastPaymentDate',
          header: 'Last payment',
          render: (r) => (r.lastPaymentDate ? formatBusinessDate(r.lastPaymentDate) : '—'),
          value: (r) => r.lastPaymentDate ?? '',
        },
        {
          key: 'imagePath',
          header: 'QR',
          sortable: false,
          value: () => '',
          render: (r) => qr(r.imagePath, r.name),
        },
      ]}
      rows={rows}
      loading={loading}
      emptyTitle={emptyTitle}
      emptyHint={emptyHint}
      onRowClick={(r) => onLedger(r.id)}
      actions={(row) => (
        <>
          <Button variant="ghost" onClick={() => onLedger(row.id)}>
            Ledger
          </Button>
          {canPay && row.duesPaise > 0 && (
            <Button variant="ghost" className="text-emerald-700" onClick={() => onPay(row)}>
              Record payment
            </Button>
          )}
        </>
      )}
    />
  );
}
