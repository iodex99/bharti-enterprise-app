import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PAYMENT_MODES, formatBusinessDate, formatPaise, formatPieces, label as enumLabel, todayIST } from '@shared';
import { api, ApiError } from '../../api/client';
import { useAuth } from '../../lib/auth';
import { DataTable } from '../../components/DataTable';
import { Badge, Button, ErrorText, Field, Modal, Select, TextInput } from '../../components/ui';
import { MoneyInput } from '../../components/inputs';

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

type StaffDue = {
  staffId: number;
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

/** Whoever is being paid: the payment modal works for contractors and staff alike. */
type Payee = {
  kind: 'contractor' | 'staff';
  id: number;
  name: string;
  duesPaise: number;
  imagePath: string | null;
};

/**
 * Pending dues at a glance (ADR-036): who is owed what right now, largest first —
 * contractors (stitching) AND checkers/packers (per-dozen pay). Payments are recorded
 * right here; partial amounts with their date are the normal case.
 */
export default function DuesPage() {
  const { user } = useAuth();
  const canPay = user?.role === 'admin' || user?.role === 'operator';
  const queryClient = useQueryClient();
  const [payFor, setPayFor] = useState<Payee | null>(null);

  const { data: contractorDues, isLoading } = useQuery({
    queryKey: ['contractors', 'dues'],
    queryFn: () => api.get<{ items: ContractorDue[]; totalDuesPaise: number }>('/api/contractors/dues'),
  });
  const { data: staffDues, isLoading: staffLoading } = useQuery({
    queryKey: ['staff', 'dues'],
    queryFn: () => api.get<{ items: StaffDue[]; totalDuesPaise: number }>('/api/staff/dues'),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['contractors'] });
    void queryClient.invalidateQueries({ queryKey: ['staff'] });
  };

  const contractorRows = contractorDues?.items.map((r) => ({ ...r, id: r.contractorId }));
  const staffRows = staffDues?.items.map((r) => ({ ...r, id: r.staffId }));
  const total = (contractorDues?.totalDuesPaise ?? 0) + (staffDues?.totalDuesPaise ?? 0);

  const qr = (path: string | null) =>
    path ? (
      <a href={path} target="_blank" rel="noreferrer" className="text-violet-600 hover:underline" title="Payment QR code">
        🔳 QR
      </a>
    ) : (
      <span className="text-gray-300">—</span>
    );

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Pending Dues</h1>
          <p className="text-sm text-gray-500">
            Who is owed what right now — record payments here (part-payments with their
            date are fine).
          </p>
        </div>
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-right">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">
            Total pending
          </p>
          <p className="text-lg font-bold text-amber-900">
            {contractorDues && staffDues ? formatPaise(total) : '…'}
          </p>
        </div>
      </div>

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-bold text-gray-900">🧵 Contractors (stitching)</h2>
        <DataTable
          columns={[
            { key: 'name', header: 'Contractor', className: 'font-medium' },
            { key: 'mobile', header: 'Mobile', className: 'text-gray-500' },
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
              key: 'duesPaise',
              header: 'Pending dues',
              className: 'font-bold',
              render: (r) => <span className="text-amber-800">{formatPaise(r.duesPaise)}</span>,
              value: (r) => r.duesPaise,
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
            { key: 'imagePath', header: 'QR', render: (r) => qr(r.imagePath) },
          ]}
          rows={contractorRows}
          loading={isLoading}
          emptyTitle="No contractor dues"
          emptyHint="Every contractor is fully paid up."
          actions={
            canPay
              ? (row) => (
                  <Button
                    variant="ghost"
                    className="text-emerald-700"
                    onClick={() =>
                      setPayFor({ kind: 'contractor', id: row.contractorId, name: row.name, duesPaise: row.duesPaise, imagePath: row.imagePath })
                    }
                  >
                    Record payment
                  </Button>
                )
              : undefined
          }
        />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-bold text-gray-900">✅ Checkers &amp; packers (per-dozen pay)</h2>
        <DataTable
          columns={[
            { key: 'name', header: 'Name', className: 'font-medium' },
            { key: 'mobile', header: 'Mobile', className: 'text-gray-500' },
            {
              key: 'work',
              header: 'Work done',
              render: (r) => (
                <span className="text-gray-600">
                  {r.checkedPcs > 0 && <>checked {formatPieces(r.checkedPcs)}</>}
                  {r.checkedPcs > 0 && r.packedPcs > 0 && ' · '}
                  {r.packedPcs > 0 && <>packed {formatPieces(r.packedPcs)}</>}
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
              key: 'duesPaise',
              header: 'Pending dues',
              className: 'font-bold',
              render: (r) => <span className="text-amber-800">{formatPaise(r.duesPaise)}</span>,
              value: (r) => r.duesPaise,
            },
            {
              key: 'lastPaymentDate',
              header: 'Last payment',
              render: (r) => (r.lastPaymentDate ? formatBusinessDate(r.lastPaymentDate) : '—'),
              value: (r) => r.lastPaymentDate ?? '',
            },
            { key: 'imagePath', header: 'QR', render: (r) => qr(r.imagePath) },
          ]}
          rows={staffRows}
          loading={staffLoading}
          emptyTitle="No checker/packer dues"
          emptyHint="Set each person's rate per dozen in Masters → Checkers & Packers; their pay accrues as they check and pack."
          actions={
            canPay
              ? (row) => (
                  <Button
                    variant="ghost"
                    className="text-emerald-700"
                    onClick={() =>
                      setPayFor({ kind: 'staff', id: row.staffId, name: row.name, duesPaise: row.duesPaise, imagePath: row.imagePath })
                    }
                  >
                    Record payment
                  </Button>
                )
              : undefined
          }
        />
      </section>

      <PaymentModal key={payFor ? `${payFor.kind}-${payFor.id}` : 'none'} payee={payFor} onClose={() => setPayFor(null)} onDone={invalidate} />
    </div>
  );
}

function PaymentModal({
  payee,
  onClose,
  onDone,
}: {
  payee: Payee | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [paymentDate, setPaymentDate] = useState(todayIST());
  const [amount, setAmount] = useState<number | null>(null);
  const [mode, setMode] = useState('upi');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');

  const save = useMutation({
    mutationFn: () =>
      payee!.kind === 'contractor'
        ? api.post('/api/contractors/payments', {
            contractorId: payee!.id,
            paymentDate,
            amountPaise: amount,
            mode,
            reference,
            notes,
          })
        : api.post('/api/staff/payments', {
            staffId: payee!.id,
            paymentDate,
            amountPaise: amount,
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

  if (!payee) return null;
  const remaining = amount != null ? payee.duesPaise - amount : null;

  return (
    <Modal title={`Record payment — ${payee.name}`} open onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!amount) {
            setError('Enter the amount paid.');
            return;
          }
          save.mutate();
        }}
        className="space-y-4"
      >
        <div className="flex items-start justify-between gap-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span>
            Pending dues: <strong>{formatPaise(payee.duesPaise)}</strong>
            {remaining != null && remaining > 0 && (
              <> · after this payment: <strong>{formatPaise(remaining)}</strong> still due</>
            )}
          </span>
          {payee.imagePath && (
            <a href={payee.imagePath} target="_blank" rel="noreferrer" title="Open the payment QR code">
              <img src={payee.imagePath} alt="Payment QR" className="h-16 w-16 rounded border border-amber-200 object-cover" />
            </a>
          )}
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Payment date">
            <TextInput type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} required />
          </Field>
          <Field label="Amount" hint="Part-payments are fine — the rest stays pending">
            <MoneyInput paise={amount} onChange={setAmount} placeholder="e.g. 500.00" />
          </Field>
        </div>
        <Field label="Mode">
          <Select value={mode} onChange={(e) => setMode(e.target.value)}>
            {PAYMENT_MODES.map((m) => (
              <option key={m} value={m}>
                {enumLabel(m)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Reference (UPI ref / cheque no.)">
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
