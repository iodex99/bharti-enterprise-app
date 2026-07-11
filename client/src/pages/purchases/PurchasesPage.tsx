import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatBusinessDate, formatCm, formatPaise, todayIST } from '@shared';
import { api, ApiError } from '../../api/client';
import { useAuth } from '../../lib/auth';
import { DataTable } from '../../components/DataTable';
import { Badge, Button, ErrorText, Field, Modal, TextInput } from '../../components/ui';
import { ImageInput, MetersInput, MoneyInput } from '../../components/inputs';
import { MasterSelect } from '../../components/MasterSelect';

type PurchaseRow = {
  id: number;
  docNo: string;
  purchaseDate: string;
  receivedDate: string;
  vendorId: number;
  vendorName: string;
  modelId: number;
  modelCode: string;
  modelName: string;
  colorId: number;
  colorName: string;
  qtyCm: number;
  ratePaisePerMeter: number;
  totalPaise: number;
  imagePath: string | null;
  notes: string;
  voidedAt: string | null;
  voidReason: string | null;
  remainingCm: number;
};

export default function PurchasesPage() {
  const { user } = useAuth();
  const canWrite = user?.role === 'admin' || user?.role === 'operator';
  const isAdmin = user?.role === 'admin';
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [voidFor, setVoidFor] = useState<PurchaseRow | null>(null);
  const [showVoided, setShowVoided] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['purchases', showVoided],
    queryFn: () =>
      api.get<{ items: PurchaseRow[] }>(`/api/purchases${showVoided ? '?includeVoided=1' : ''}`),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['purchases'] });
    void queryClient.invalidateQueries({ queryKey: ['stock'] });
  };

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Raw Material Purchases</h1>
          <p className="text-sm text-gray-500">Cloth received from vendors (Module 1)</p>
        </div>
        {canWrite && <Button onClick={() => setCreateOpen(true)}>+ New purchase</Button>}
      </div>

      <DataTable
        columns={[
          { key: 'docNo', header: 'Batch', className: 'font-mono text-xs font-medium' },
          {
            key: 'purchaseDate',
            header: 'Date',
            render: (r) => formatBusinessDate(r.purchaseDate),
            value: (r) => r.purchaseDate,
          },
          { key: 'vendorName', header: 'Vendor' },
          {
            key: 'item',
            header: 'Model / Color',
            value: (r) => `${r.modelCode} ${r.colorName}`,
            render: (r) => (
              <span>
                <span className="font-medium">{r.modelCode}</span>{' '}
                <span className="text-gray-500">{r.colorName}</span>
              </span>
            ),
          },
          { key: 'qtyCm', header: 'Quantity', render: (r) => formatCm(r.qtyCm), value: (r) => r.qtyCm },
          {
            key: 'remainingCm',
            header: 'Remaining',
            render: (r) =>
              r.voidedAt ? (
                <Badge tone="red">voided</Badge>
              ) : r.remainingCm === 0 ? (
                <Badge tone="gray">fully used</Badge>
              ) : (
                <span className={r.remainingCm < r.qtyCm ? 'text-amber-700' : ''}>
                  {formatCm(r.remainingCm)}
                </span>
              ),
          },
          {
            key: 'ratePaisePerMeter',
            header: 'Rate/m',
            render: (r) => formatPaise(r.ratePaisePerMeter),
          },
          { key: 'totalPaise', header: 'Total', render: (r) => formatPaise(r.totalPaise), className: 'font-medium' },
        ]}
        rows={data?.items}
        loading={isLoading}
        emptyTitle="No purchases recorded yet"
        emptyHint={canWrite ? 'Press “+ New purchase” to record the first cloth purchase.' : undefined}
        facets={[
          { key: 'vendor', label: 'Vendor', value: (r) => r.vendorName },
          { key: 'model', label: 'Model', value: (r) => r.modelCode },
          { key: 'color', label: 'Color', value: (r) => r.colorName },
        ]}
        dateRange={{ label: 'Purchase date', value: (r) => r.purchaseDate }}
        toolbar={
          <label className="flex items-center gap-1.5 text-sm text-gray-500">
            <input
              type="checkbox"
              checked={showVoided}
              onChange={(e) => setShowVoided(e.target.checked)}
              className="rounded border-gray-300"
            />
            Show voided
          </label>
        }
        actions={
          isAdmin
            ? (row) =>
                row.voidedAt ? null : (
                  <Button variant="ghost" className="text-red-600" onClick={() => setVoidFor(row)}>
                    Void
                  </Button>
                )
            : undefined
        }
      />

      <NewPurchaseModal
        key={String(createOpen)}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onDone={invalidate}
      />
      <VoidModal
        entity="purchase"
        target={voidFor ? { id: voidFor.id, label: voidFor.docNo, url: `/api/purchases/${voidFor.id}/void` } : null}
        onClose={() => setVoidFor(null)}
        onDone={invalidate}
      />
    </div>
  );
}

function NewPurchaseModal({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [purchaseDate, setPurchaseDate] = useState(todayIST());
  const [receivedDate, setReceivedDate] = useState(todayIST());
  const [vendorId, setVendorId] = useState<number | null>(null);
  const [modelId, setModelId] = useState<number | null>(null);
  const [colorId, setColorId] = useState<number | null>(null);
  const [qtyCm, setQtyCm] = useState<number | null>(null);
  const [rate, setRate] = useState<number | null>(null);
  const [imagePath, setImagePath] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');

  const totalPreview =
    qtyCm != null && rate != null ? formatPaise(Math.round((qtyCm * rate) / 100)) : '—';

  const save = useMutation({
    mutationFn: () =>
      api.post(
        '/api/purchases',
        {
          purchaseDate,
          receivedDate,
          vendorId,
          modelId,
          colorId,
          qtyCm,
          ratePaisePerMeter: rate ?? 0,
          imagePath,
          notes,
        },
      ),
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Save failed.'),
  });

  return (
    <Modal title="New raw material purchase" open={open} onClose={onClose} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!vendorId || !modelId || !colorId) {
            setError('Pick vendor, model and color.');
            return;
          }
          if (!qtyCm) {
            setError('Enter the cloth quantity in meters.');
            return;
          }
          save.mutate();
        }}
        className="grid grid-cols-1 gap-4 sm:grid-cols-2"
      >
        <Field label="Purchase date">
          <TextInput type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} required />
        </Field>
        <Field label="Date received">
          <TextInput type="date" value={receivedDate} onChange={(e) => setReceivedDate(e.target.value)} required />
        </Field>
        <Field label="Vendor">
          <MasterSelect master="vendors" value={vendorId} onChange={setVendorId} />
        </Field>
        <Field label="Model">
          <MasterSelect master="models" value={modelId} onChange={setModelId} />
        </Field>
        <Field label="Color">
          <MasterSelect master="colors" value={colorId} onChange={setColorId} />
        </Field>
        <Field label="Quantity (meters)">
          <MetersInput cm={qtyCm} onChange={setQtyCm} placeholder="e.g. 125.5" />
        </Field>
        <Field label="Rate per meter">
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
            {save.isPending ? 'Saving…' : 'Save purchase'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Shared admin void dialog (reused by other documents in later modules). */
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
          Voiding reverses this {entity}'s stock movements. The record stays in history with
          your reason. This cannot be undone.
        </p>
        <Field label="Reason (required)">
          <TextInput value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} />
        </Field>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" variant="danger" disabled={doVoid.isPending} className="w-full">
          {doVoid.isPending ? 'Voiding…' : `Void ${entity}`}
        </Button>
      </form>
    </Modal>
  );
}
