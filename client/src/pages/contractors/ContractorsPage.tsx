import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatBusinessDate,
  formatPaise,
  formatPieces,
  label as enumLabel,
  PAYMENT_MODES,
  todayIST,
} from '@shared';
import { api, ApiError } from '../../api/client';
import { useAuth } from '../../lib/auth';
import { DataTable } from '../../components/DataTable';
import { Badge, Button, ErrorText, Field, Modal, Select, TextInput } from '../../components/ui';
import { MoneyInput } from '../../components/inputs';
import { MasterSelect } from '../../components/MasterSelect';
import { VoidModal } from '../purchases/PurchasesPage';

type ContractorStats = {
  id: number;
  name: string;
  mobile: string;
  isActive: number;
  totalJobs: number;
  openJobs: number;
  discrepancyJobs: number;
  issuedPcs: number;
  receivedPcs: number;
  unstitchedReturnedPcs: number;
  shortagePcs: number;
  excessPcs: number;
  discrepancyPct: number;
  jobWorkCostPaise: number;
  paidPaise: number;
  duesPaise: number;
  avgTurnaroundDays: number | null;
};

type Payment = {
  id: number;
  docNo: string;
  paymentDate: string;
  amountPaise: number;
  mode: string;
  reference: string;
  notes: string;
  voidedAt: string | null;
  contractorId: number;
  contractorName: string;
};

export default function ContractorsPage() {
  const { user } = useAuth();
  const canWrite = user?.role === 'admin' || user?.role === 'operator';
  const isAdmin = user?.role === 'admin';
  const queryClient = useQueryClient();
  const [payOpen, setPayOpen] = useState(false);
  const [voidFor, setVoidFor] = useState<Payment | null>(null);
  const [tab, setTab] = useState<'performance' | 'payments'>('performance');

  const { data: analytics, isLoading } = useQuery({
    queryKey: ['contractors', 'analytics'],
    queryFn: () => api.get<{ items: ContractorStats[] }>('/api/contractors/analytics'),
  });
  const { data: payments } = useQuery({
    queryKey: ['contractors', 'payments'],
    queryFn: () => api.get<{ items: Payment[] }>('/api/contractors/payments'),
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['contractors'] });

  // performance ranking: lowest discrepancy first, then most delivered
  const ranked = analytics
    ? [...analytics.items]
        .filter((c) => c.totalJobs > 0)
        .sort((a, b) => a.discrepancyPct - b.discrepancyPct || b.receivedPcs - a.receivedPcs)
    : [];

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Contractors</h1>
          <p className="text-sm text-gray-500">Performance, job-work dues and payments</p>
        </div>
        {canWrite && <Button onClick={() => setPayOpen(true)}>+ Record payment</Button>}
      </div>

      <div className="mb-4 flex gap-1 rounded-xl bg-gray-100 p-1 text-sm font-medium sm:w-fit">
        {(['performance', 'payments'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 rounded-lg px-4 py-1.5 capitalize sm:flex-none ${
              tab === t ? 'bg-white shadow text-gray-900' : 'text-gray-500'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'performance' && (
        <DataTable
          columns={[
            {
              key: 'rank',
              header: '#',
              className: 'w-10 text-gray-400',
              render: (r) => {
                const i = ranked.findIndex((c) => c.id === r.id);
                return i >= 0 ? i + 1 : '—';
              },
            },
            { key: 'name', header: 'Contractor', className: 'font-medium' },
            {
              key: 'totalJobs',
              header: 'Jobs',
              render: (r) => `${r.totalJobs} (${r.openJobs} open)`,
            },
            { key: 'issuedPcs', header: 'Issued', render: (r) => formatPieces(r.issuedPcs) },
            { key: 'receivedPcs', header: 'Received', render: (r) => formatPieces(r.receivedPcs) },
            {
              key: 'shortExcess',
              header: 'Short / Excess',
              render: (r) => (
                <span>
                  {r.shortagePcs > 0 && <Badge tone="red">−{formatPieces(r.shortagePcs)}</Badge>}{' '}
                  {r.excessPcs > 0 && <Badge tone="blue">+{formatPieces(r.excessPcs)}</Badge>}
                  {r.shortagePcs === 0 && r.excessPcs === 0 && (
                    <span className="text-gray-300">—</span>
                  )}
                </span>
              ),
            },
            {
              key: 'discrepancyPct',
              header: 'Discrepancy %',
              render: (r) =>
                r.discrepancyPct === 0 ? (
                  <Badge tone="green">0%</Badge>
                ) : (
                  <Badge tone={r.discrepancyPct > 5 ? 'red' : 'amber'}>{r.discrepancyPct}%</Badge>
                ),
            },
            {
              key: 'avgTurnaroundDays',
              header: 'Avg turnaround',
              render: (r) => (r.avgTurnaroundDays == null ? '—' : `${r.avgTurnaroundDays} days`),
            },
            {
              key: 'jobWorkCostPaise',
              header: 'Job-work cost',
              render: (r) => formatPaise(r.jobWorkCostPaise),
            },
            {
              key: 'duesPaise',
              header: 'Dues',
              className: 'font-semibold',
              render: (r) =>
                r.duesPaise > 0 ? (
                  <span className="text-red-700">{formatPaise(r.duesPaise)}</span>
                ) : r.duesPaise < 0 ? (
                  <span className="text-blue-700">{formatPaise(r.duesPaise)} (advance)</span>
                ) : (
                  <span className="text-gray-400">{formatPaise(0)}</span>
                ),
            },
          ]}
          rows={analytics?.items}
          loading={isLoading}
          emptyTitle="No contractors yet"
        />
      )}

      {tab === 'payments' && (
        <DataTable
          columns={[
            { key: 'docNo', header: 'Doc', className: 'font-mono text-xs' },
            {
              key: 'paymentDate',
              header: 'Date',
              render: (r) => formatBusinessDate(r.paymentDate),
            },
            { key: 'contractorName', header: 'Contractor', className: 'font-medium' },
            {
              key: 'amountPaise',
              header: 'Amount',
              className: 'font-semibold',
              render: (r) =>
                r.voidedAt ? <Badge tone="red">voided</Badge> : formatPaise(r.amountPaise),
            },
            { key: 'mode', header: 'Mode', render: (r) => enumLabel(r.mode) },
            { key: 'reference', header: 'Reference', className: 'text-gray-500' },
          ]}
          rows={payments?.items}
          emptyTitle="No payments recorded"
          facets={[
            { key: 'contractor', label: 'Contractor', value: (r) => r.contractorName },
            { key: 'mode', label: 'Mode', value: (r) => enumLabel(r.mode) },
          ]}
          dateRange={{ label: 'Payment date', value: (r) => r.paymentDate }}
          actions={
            isAdmin
              ? (row) =>
                  row.voidedAt ? null : (
                    <Button
                      variant="ghost"
                      className="text-red-600"
                      onClick={() => setVoidFor(row)}
                    >
                      Void
                    </Button>
                  )
              : undefined
          }
        />
      )}

      <PaymentModal
        key={String(payOpen)}
        open={payOpen}
        onClose={() => setPayOpen(false)}
        onDone={invalidate}
        dues={analytics?.items ?? []}
      />
      <VoidModal
        entity="payment"
        target={
          voidFor
            ? {
                id: voidFor.id,
                label: voidFor.docNo,
                url: `/api/contractors/payments/${voidFor.id}/void`,
              }
            : null
        }
        onClose={() => setVoidFor(null)}
        onDone={invalidate}
      />
    </div>
  );
}

function PaymentModal({
  open,
  onClose,
  onDone,
  dues,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  dues: ContractorStats[];
}) {
  const [contractorId, setContractorId] = useState<number | null>(null);
  const [paymentDate, setPaymentDate] = useState(todayIST());
  const [amountPaise, setAmount] = useState<number | null>(null);
  const [mode, setMode] = useState('cash');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');

  const currentDues = dues.find((d) => d.id === contractorId)?.duesPaise;

  const save = useMutation({
    mutationFn: () =>
      api.post('/api/contractors/payments', {
        contractorId,
        paymentDate,
        amountPaise,
        mode,
        reference,
        notes,
      }),
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Save failed.'),
  });

  return (
    <Modal title="Record contractor payment" open={open} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="space-y-4"
      >
        <Field
          label="Contractor"
          hint={currentDues != null ? `Current dues: ${formatPaise(currentDues)}` : undefined}
        >
          <MasterSelect master="contractors" value={contractorId} onChange={setContractorId} />
        </Field>
        <Field label="Payment date">
          <TextInput
            type="date"
            value={paymentDate}
            onChange={(e) => setPaymentDate(e.target.value)}
            required
          />
        </Field>
        <Field label="Amount">
          <MoneyInput paise={amountPaise} onChange={setAmount} />
        </Field>
        <Field label="Mode">
          <Select value={mode} onChange={(e) => setMode(e.target.value)}>
            {PAYMENT_MODES.map((m) => (
              <option key={m} value={m}>
                {enumLabel(m)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Reference (UPI/cheque no.)">
          <TextInput value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
        <Field label="Notes">
          <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" disabled={save.isPending} className="w-full">
          {save.isPending ? 'Saving…' : 'Record payment'}
        </Button>
      </form>
    </Modal>
  );
}
