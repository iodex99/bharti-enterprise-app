import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatBusinessDate, formatInchC, formatLen, formatPaise, todayIST } from '@shared';
import { api, ApiError } from '../../api/client';
import { useAuth } from '../../lib/auth';
import { DataTable } from '../../components/DataTable';
import {
  Badge,
  Button,
  ErrorText,
  Field,
  Modal,
  PageHeader,
  PhotoThumb,
  TextInput,
} from '../../components/ui';
import { ImageInput, InchesInput, MoneyInput, YardsInput } from '../../components/inputs';
import { MasterSelect } from '../../components/MasterSelect';

type PurchaseRow = {
  id: number;
  docNo: string;
  purchaseDate: string;
  receivedDate: string;
  vendorId: number;
  vendorName: string;
  colorId: number;
  colorName: string;
  lenInchC: number;
  widthInchC: number | null;
  ratePaisePerYard: number;
  totalPaise: number;
  imagePath: string | null;
  notes: string;
  voidedAt: string | null;
  voidReason: string | null;
  remainingInchC: number;
};

export default function PurchasesPage() {
  const { user } = useAuth();
  const canWrite = user?.role === 'admin' || user?.role === 'operator';
  const isAdmin = user?.role === 'admin';
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editFor, setEditFor] = useState<PurchaseRow | null>(null);
  const [voidFor, setVoidFor] = useState<PurchaseRow | null>(null);

  // voided ones come too — the "Voided" chip shows them, the default chips hide them
  const { data, isLoading } = useQuery({
    queryKey: ['purchases', 'all'],
    queryFn: () => api.get<{ items: PurchaseRow[] }>('/api/purchases?includeVoided=1'),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['purchases'] });
    void queryClient.invalidateQueries({ queryKey: ['stock'] });
  };

  return (
    <div className="p-4 sm:p-6">
      <PageHeader
        title="Raw Material Purchases"
        subtitle="Cloth received from vendors — length in yards, width in inches"
        action={canWrite && <Button onClick={() => setCreateOpen(true)}>+ New purchase</Button>}
      />

      <DataTable
        columns={[
          { key: 'docNo', header: 'Batch', className: 'font-mono text-xs font-medium' },
          {
            key: 'imagePath',
            header: 'Photo',
            sortable: false,
            value: () => '',
            render: (r) =>
              r.imagePath ? <PhotoThumb src={r.imagePath} title={`Purchase ${r.docNo}`} /> : '',
          },
          {
            key: 'purchaseDate',
            header: 'Date',
            render: (r) => formatBusinessDate(r.purchaseDate),
            value: (r) => r.purchaseDate,
          },
          { key: 'vendorName', header: 'Vendor' },
          // no code here — the code number is given at cutting
          { key: 'colorName', header: 'Color', className: 'font-medium' },
          {
            key: 'lenInchC',
            header: 'Length',
            // register color code: red = goods received in
            render: (r) => (
              <span className="font-medium text-red-700">{formatLen(r.lenInchC)}</span>
            ),
            value: (r) => r.lenInchC,
          },
          {
            key: 'widthInchC',
            header: 'Width',
            render: (r) => (r.widthInchC ? formatInchC(r.widthInchC) : '—'),
            value: (r) => r.widthInchC ?? 0,
          },
          {
            key: 'remainingInchC',
            header: 'Remaining',
            render: (r) =>
              r.voidedAt ? (
                <Badge tone="red">voided</Badge>
              ) : r.remainingInchC === 0 ? (
                <Badge tone="gray">fully used</Badge>
              ) : (
                <span className={r.remainingInchC < r.lenInchC ? 'text-amber-700' : ''}>
                  {formatLen(r.remainingInchC)}
                </span>
              ),
          },
          {
            key: 'ratePaisePerYard',
            header: 'Rate/yd',
            render: (r) => formatPaise(r.ratePaisePerYard),
          },
          {
            key: 'totalPaise',
            header: 'Total',
            render: (r) => formatPaise(r.totalPaise),
            className: 'font-medium',
          },
        ]}
        rows={data?.items}
        loading={isLoading}
        emptyTitle="No purchases recorded yet"
        emptyHint={
          canWrite ? 'Press “+ New purchase” to record the first cloth purchase.' : undefined
        }
        quickFilters={[
          { key: 'stock', label: 'In stock', test: (r) => !r.voidedAt && r.remainingInchC > 0 },
          { key: 'used', label: 'Fully used', test: (r) => !r.voidedAt && r.remainingInchC === 0 },
          { key: 'voided', label: 'Voided', test: (r) => !!r.voidedAt },
        ]}
        defaultQuick="stock"
        facets={[
          { key: 'vendor', label: 'Vendor', value: (r) => r.vendorName },
          { key: 'color', label: 'Color', value: (r) => r.colorName },
        ]}
        dateRange={{ label: 'Purchase date', value: (r) => r.purchaseDate }}
        onRowClick={canWrite ? (row) => !row.voidedAt && setEditFor(row) : undefined}
        actions={(row) =>
          row.voidedAt ? null : (
            <>
              {canWrite && (
                <Button variant="ghost" onClick={() => setEditFor(row)}>
                  Edit
                </Button>
              )}
              {isAdmin && (
                <Button variant="ghost" className="text-red-600" onClick={() => setVoidFor(row)}>
                  Void
                </Button>
              )}
            </>
          )
        }
      />

      <PurchaseModal
        key={String(createOpen)}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onDone={invalidate}
      />
      {editFor && (
        <PurchaseModal
          key={`edit-${editFor.id}`}
          open
          existing={editFor}
          onClose={() => setEditFor(null)}
          onDone={invalidate}
        />
      )}
      <VoidModal
        entity="purchase"
        target={
          voidFor
            ? { id: voidFor.id, label: voidFor.docNo, url: `/api/purchases/${voidFor.id}/void` }
            : null
        }
        onClose={() => setVoidFor(null)}
        onDone={invalidate}
      />
    </div>
  );
}

/**
 * New purchase, or edit an existing one. Everything is editable while the cloth is
 * untouched; once some is cut, color and width lock and length can't drop below what
 * was used (the server enforces it — the form says so up front).
 */
function PurchaseModal({
  open,
  existing,
  onClose,
  onDone,
}: {
  open: boolean;
  existing?: PurchaseRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const used = existing ? existing.lenInchC - existing.remainingInchC : 0;
  const [purchaseDate, setPurchaseDate] = useState(existing?.purchaseDate ?? todayIST());
  const [receivedDate, setReceivedDate] = useState(existing?.receivedDate ?? todayIST());
  const [vendorId, setVendorId] = useState<number | null>(existing?.vendorId ?? null);
  const [colorId, setColorId] = useState<number | null>(existing?.colorId ?? null);
  const [lenInchC, setLenInchC] = useState<number | null>(existing?.lenInchC ?? null);
  const [widthInchC, setWidthInchC] = useState<number | null>(existing?.widthInchC ?? null);
  const [rate, setRate] = useState<number | null>(existing?.ratePaisePerYard ?? null);
  const [imagePath, setImagePath] = useState<string | null>(existing?.imagePath ?? null);
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [error, setError] = useState('');

  const totalPreview =
    lenInchC != null && rate != null ? formatPaise(Math.round((lenInchC * rate) / 3600)) : '—';

  const save = useMutation({
    mutationFn: () => {
      const body = {
        purchaseDate,
        receivedDate,
        vendorId,
        colorId,
        lenInchC,
        widthInchC,
        ratePaisePerYard: rate ?? 0,
        imagePath,
        notes,
      };
      return existing
        ? api.put(`/api/purchases/${existing.id}`, body)
        : api.post('/api/purchases', body);
    },
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Save failed.'),
  });

  return (
    <Modal
      title={existing ? `Edit purchase ${existing.docNo}` : 'New raw material purchase'}
      open={open}
      onClose={onClose}
      wide
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!vendorId || !colorId) {
            setError('Pick vendor and color.');
            return;
          }
          if (!lenInchC) {
            setError('Enter the cloth length in yards.');
            return;
          }
          if (!widthInchC) {
            setError('Enter the cloth width in inches.');
            return;
          }
          save.mutate();
        }}
        className="grid grid-cols-1 gap-4 sm:grid-cols-2"
      >
        {used > 0 && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 sm:col-span-2">
            {formatLen(used)} of this cloth is already cut, so its color and width are fixed and the
            length can't go below that. Everything else can be corrected.
          </p>
        )}
        <Field label="Purchase date">
          <TextInput
            type="date"
            value={purchaseDate}
            onChange={(e) => setPurchaseDate(e.target.value)}
            required
          />
        </Field>
        <Field label="Date received">
          <TextInput
            type="date"
            value={receivedDate}
            onChange={(e) => setReceivedDate(e.target.value)}
            required
          />
        </Field>
        <Field label="Vendor">
          <MasterSelect master="vendors" value={vendorId} onChange={setVendorId} />
        </Field>
        <Field label="Color" hint="The code number is given later, at cutting">
          <MasterSelect master="colors" value={colorId} onChange={setColorId} disabled={used > 0} />
        </Field>
        <Field label="Length (yards)">
          <YardsInput inchC={lenInchC} onChange={setLenInchC} placeholder="e.g. 125.5" />
        </Field>
        <Field label="Width (inches)" hint="Used at cutting to work out pieces across the width">
          <InchesInput
            inchC={widthInchC}
            onChange={setWidthInchC}
            placeholder="e.g. 44"
            disabled={used > 0}
          />
        </Field>
        <Field label="Rate per yard">
          <MoneyInput paise={rate} onChange={setRate} placeholder="e.g. 45.50" />
        </Field>
        <Field label="Total (auto)">
          <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-700">
            {totalPreview}
          </div>
        </Field>
        <div className="sm:col-span-2">
          <Field label="Reference photo (bill / cloth)">
            <ImageInput path={imagePath} onChange={setImagePath} />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="Notes">
            <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
        <div className="sm:col-span-2 space-y-3">
          <ErrorText>{error}</ErrorText>
          <Button type="submit" disabled={save.isPending} className="w-full">
            {save.isPending ? 'Saving…' : existing ? 'Save changes' : 'Save purchase'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Shared admin void dialog (reused by other documents). */
export function VoidModal({
  entity,
  target,
  onClose,
  onDone,
}: {
  entity: string;
  target: { id: number; label: string; url: string } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  const doVoid = useMutation({
    mutationFn: () => api.post(target!.url, { reason }),
    onSuccess: () => {
      setReason('');
      setError('');
      onDone();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Void failed.'),
  });

  return (
    <Modal title={`Void ${entity} ${target?.label ?? ''}`} open={!!target} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          doVoid.mutate();
        }}
        className="space-y-4"
      >
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Voiding reverses this {entity}'s stock movements. The record stays in history with your
          reason. This cannot be undone.
        </p>
        <Field label="Reason (required)">
          <TextInput
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            minLength={3}
          />
        </Field>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" variant="danger" disabled={doVoid.isPending} className="w-full">
          {doVoid.isPending ? 'Voiding…' : `Void ${entity}`}
        </Button>
      </form>
    </Modal>
  );
}
