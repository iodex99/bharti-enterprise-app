import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatBusinessDate, formatPieces, todayIST } from '@shared';
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
  Select,
  TextInput,
} from '../../components/ui';
import { DzPcInput } from '../../components/inputs';
import { MasterSelect } from '../../components/MasterSelect';
import { useProducts } from '../../api/products';
import { VoidModal } from '../purchases/PurchasesPage';

type Dispatch = {
  id: number;
  docNo: string;
  dispatchDate: string;
  modelId: number;
  colorId: number;
  sizeId: number;
  modelImagePath: string | null;
  modelCode: string;
  colorName: string;
  sizeCode: string;
  qtyPcs: number;
  notes: string;
  voidedAt: string | null;
};

/** Minimal FG stock-out so finished goods don't only ever grow. Full sales module: roadmap. */
export default function DispatchesPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editFor, setEditFor] = useState<Dispatch | null>(null);
  const [voidFor, setVoidFor] = useState<Dispatch | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['dispatches'],
    queryFn: () => api.get<{ items: Dispatch[] }>('/api/dispatches'),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['dispatches'] });
    void queryClient.invalidateQueries({ queryKey: ['stock'] });
  };

  return (
    <div className="p-4 sm:p-6">
      <PageHeader
        title="Dispatches"
        subtitle="Finished goods sent out for sale (admin only)"
        action={isAdmin && <Button onClick={() => setCreateOpen(true)}>+ New dispatch</Button>}
      />

      <DataTable
        columns={[
          { key: 'docNo', header: 'Doc', className: 'font-mono text-xs font-medium' },
          {
            key: 'dispatchDate',
            header: 'Date',
            render: (r) => formatBusinessDate(r.dispatchDate),
          },
          {
            key: 'item',
            header: 'Item',
            value: (r) => `${r.modelCode} ${r.colorName} ${r.sizeCode}`,
            render: (r) => (
              <span className="inline-flex items-center gap-2">
                {r.modelImagePath && (
                  <PhotoThumb src={r.modelImagePath} title={r.modelCode} size={32} />
                )}
                <span>
                  <span className="font-medium">{r.modelCode}</span>{' '}
                  <span className="text-gray-500">
                    {r.colorName} · {r.sizeCode}
                  </span>
                </span>
              </span>
            ),
          },
          {
            key: 'qtyPcs',
            header: 'Quantity',
            className: 'font-semibold',
            // register color code: blue = goods issued out (for sale)
            render: (r) =>
              r.voidedAt ? (
                <Badge tone="red">voided</Badge>
              ) : (
                <span className="text-sky-700">{formatPieces(r.qtyPcs)}</span>
              ),
            value: (r) => r.qtyPcs,
          },
          { key: 'notes', header: 'Notes', className: 'text-gray-500' },
        ]}
        rows={data?.items}
        loading={isLoading}
        emptyTitle="No dispatches yet"
        quickFilters={[
          { key: 'active', label: 'Dispatched', test: (r) => !r.voidedAt },
          { key: 'voided', label: 'Voided', test: (r) => !!r.voidedAt },
        ]}
        defaultQuick="active"
        facets={[
          { key: 'model', label: 'Code', value: (r) => r.modelCode },
          { key: 'color', label: 'Color', value: (r) => r.colorName },
        ]}
        dateRange={{ label: 'Dispatch date', value: (r) => r.dispatchDate }}
        actions={
          isAdmin
            ? (row) =>
                row.voidedAt ? null : (
                  <>
                    <Button variant="ghost" onClick={() => setEditFor(row)}>
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      className="text-red-600"
                      onClick={() => setVoidFor(row)}
                    >
                      Void
                    </Button>
                  </>
                )
            : undefined
        }
      />

      <DispatchModal
        key={String(createOpen)}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onDone={invalidate}
      />
      {editFor && (
        <DispatchModal
          key={`edit-${editFor.id}`}
          open
          existing={editFor}
          onClose={() => setEditFor(null)}
          onDone={invalidate}
        />
      )}
      <VoidModal
        entity="dispatch"
        target={
          voidFor
            ? { id: voidFor.id, label: voidFor.docNo, url: `/api/dispatches/${voidFor.id}/void` }
            : null
        }
        onClose={() => setVoidFor(null)}
        onDone={invalidate}
      />
    </div>
  );
}

/** New dispatch, or correct one (its old take goes back to stock and it takes again). */
function DispatchModal({
  open,
  existing,
  onClose,
  onDone,
}: {
  open: boolean;
  existing?: Dispatch;
  onClose: () => void;
  onDone: () => void;
}) {
  const [dispatchDate, setDate] = useState(existing?.dispatchDate ?? todayIST());
  const [modelId, setModelId] = useState<number | null>(existing?.modelId ?? null);
  const [colorId, setColorId] = useState<number | null>(existing?.colorId ?? null);
  const [sizeId, setSizeId] = useState<number | null>(existing?.sizeId ?? null);
  const [qtyPcs, setQty] = useState<number | null>(existing?.qtyPcs ?? null);
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [error, setError] = useState('');

  const save = useMutation({
    mutationFn: () => {
      const body = { dispatchDate, modelId, colorId, sizeId, qtyPcs, notes };
      return existing
        ? api.put(`/api/dispatches/${existing.id}`, body)
        : api.post('/api/dispatches', body);
    },
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Save failed.'),
  });

  return (
    <Modal
      title={existing ? `Edit dispatch ${existing.docNo}` : 'New dispatch (stock out)'}
      open={open}
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="space-y-4"
      >
        <Field label="Dispatch date">
          <TextInput
            type="date"
            value={dispatchDate}
            onChange={(e) => setDate(e.target.value)}
            required
          />
        </Field>
        <Field label="Code">
          <ProductSelect value={modelId} onChange={setModelId} />
        </Field>
        <Field label="Color">
          <MasterSelect master="colors" value={colorId} onChange={setColorId} />
        </Field>
        <Field label="Size">
          <MasterSelect master="sizes" value={sizeId} onChange={setSizeId} />
        </Field>
        <Field label="Quantity">
          <DzPcInput pieces={qtyPcs} onChange={setQty} />
        </Field>
        <Field label="Notes (customer / destination)">
          <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" disabled={save.isPending} className="w-full">
          {save.isPending ? 'Saving…' : existing ? 'Save changes' : 'Dispatch'}
        </Button>
      </form>
    </Modal>
  );
}

function ProductSelect({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (id: number | null) => void;
}) {
  const { data: products } = useProducts();
  return (
    <Select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
    >
      <option value="" disabled>
        — select code —
      </option>
      {products?.map((p) => (
        <option key={p.id} value={p.id}>
          {p.code}
        </option>
      ))}
    </Select>
  );
}
