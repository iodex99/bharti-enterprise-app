import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { PAYMENT_MODES, formatPaise, label as enumLabel, todayIST } from '@shared';
import { api, ApiError } from '../../api/client';
import {
  Button,
  ErrorText,
  Field,
  Modal,
  PhotoThumb,
  Select,
  TextInput,
} from '../../components/ui';
import { MoneyInput } from '../../components/inputs';

/** Whoever is being paid: contractors and checkers/packers alike. */
export type Payee = {
  kind: 'contractor' | 'staff';
  id: number;
  name: string;
  duesPaise: number;
  imagePath: string | null;
};

/** An existing payment being corrected (admin). */
export type ExistingPayment = {
  id: number;
  docNo: string;
  paymentDate: string;
  amountPaise: number;
  mode: string;
  reference: string;
  notes: string;
};

const base = (kind: Payee['kind']) => (kind === 'contractor' ? '/api/contractors' : '/api/staff');

/**
 * Record a payment — or correct one. Part-payments with their date are the normal case;
 * the person's payment QR is right there to scan.
 */
export function PaymentModal({
  payee,
  existing,
  onClose,
  onDone,
}: {
  payee: Payee | null;
  existing?: ExistingPayment;
  onClose: () => void;
  onDone: () => void;
}) {
  const [paymentDate, setPaymentDate] = useState(existing?.paymentDate ?? todayIST());
  const [amount, setAmount] = useState<number | null>(existing?.amountPaise ?? null);
  const [mode, setMode] = useState(existing?.mode ?? 'upi');
  const [reference, setReference] = useState(existing?.reference ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [error, setError] = useState('');

  const save = useMutation({
    mutationFn: () => {
      const body = { paymentDate, amountPaise: amount, mode, reference, notes };
      if (existing) return api.put(`${base(payee!.kind)}/payments/${existing.id}`, body);
      return api.post(`${base(payee!.kind)}/payments`, {
        ...body,
        ...(payee!.kind === 'contractor' ? { contractorId: payee!.id } : { staffId: payee!.id }),
      });
    },
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Save failed.'),
  });

  if (!payee) return null;
  // when correcting, the balance shown is what it would be without this payment
  const dueBefore = payee.duesPaise + (existing?.amountPaise ?? 0);
  const remaining = amount != null ? dueBefore - amount : null;

  return (
    <Modal
      title={
        existing
          ? `Edit payment ${existing.docNo} — ${payee.name}`
          : `Record payment — ${payee.name}`
      }
      open
      onClose={onClose}
    >
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
            Pending dues: <strong>{formatPaise(dueBefore)}</strong>
            {remaining != null && remaining > 0 && (
              <>
                {' '}
                · after this payment: <strong>{formatPaise(remaining)}</strong> still due
              </>
            )}
            {remaining != null && remaining < 0 && (
              <>
                {' '}
                · this pays <strong>{formatPaise(-remaining)}</strong> in advance
              </>
            )}
          </span>
          {payee.imagePath && (
            <PhotoThumb src={payee.imagePath} title={`${payee.name} — payment QR`} size={64} />
          )}
        </div>
        <Field label="Amount" hint="Part-payments are fine — the rest stays pending">
          <div className="space-y-1.5">
            <MoneyInput
              key={existing?.id ?? 'new'}
              paise={amount}
              onChange={setAmount}
              placeholder="e.g. 500.00"
            />
          </div>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Payment date">
            <TextInput
              type="date"
              value={paymentDate}
              onChange={(e) => setPaymentDate(e.target.value)}
              required
            />
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
        </div>
        <Field label="Reference (UPI ref / cheque no.)">
          <TextInput value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
        <Field label="Notes">
          <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" disabled={save.isPending} className="w-full">
          {save.isPending ? 'Saving…' : existing ? 'Save changes' : 'Record payment'}
        </Button>
      </form>
    </Modal>
  );
}
