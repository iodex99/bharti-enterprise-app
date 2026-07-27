import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  clothRequiredInchC,
  formatBusinessDate,
  formatInchC,
  formatLen,
  formatPieces,
  todayIST,
} from '@shared';
import { api, ApiError } from '../../api/client';
import { useAuth } from '../../lib/auth';
import { DataTable } from '../../components/DataTable';
import { Badge, Button, ErrorText, Field, Modal, Select, TextInput, ThumbLink } from '../../components/ui';
import { DzPcInput, ImageInput, InchesInput } from '../../components/inputs';
import { MasterSelect } from '../../components/MasterSelect';
import { VoidModal } from '../purchases/PurchasesPage';

/**
 * Cutting v2 (ADR-030/031): the entry IS the cutting — recording it consumes the cloth
 * and creates the cut pieces at once. The CODE NUMBER is typed on each size line (with
 * its photo) and becomes the "size-code" used everywhere. Entries can be edited or
 * deleted while none of their pieces have gone to a contractor.
 */

type CutLine = {
  id: number;
  sizeId: number;
  sizeCode: string;
  modelId: number | null;
  code: string | null;
  sizeCodeLabel: string;
  imagePath: string | null;
  qtyPcs: number;
  clothPerPcInchC: number | null;
  widthCount: number | null;
  remainingPcs: number;
};

type Batch = {
  id: number;
  docNo: string;
  cutDate: string;
  status: string;
  rawLotType: 'purchase' | 'opening';
  rawLotId: number;
  rawDocNo: string;
  consumedInchC: number;
  colorId: number;
  colorName: string;
  notes: string;
  voidedAt: string | null;
  editable: boolean;
  totalPcs: number;
  lines: CutLine[];
};

type RawLot = {
  lotType: 'purchase' | 'opening';
  lotId: number;
  colorId: number;
  colorName: string;
  purchaseDocNo: string | null;
  openingDocNo: string | null;
  vendorName: string | null;
  widthInchC: number | null;
  qtyInchC: number;
};

export default function CuttingPage() {
  const { user } = useAuth();
  const canWrite = user?.role === 'admin' || user?.role === 'operator';
  const isAdmin = user?.role === 'admin';
  const queryClient = useQueryClient();
  const [planOpen, setPlanOpen] = useState(false);
  const [editBatch, setEditBatch] = useState<Batch | null>(null);
  const [deleteBatch, setDeleteBatch] = useState<Batch | null>(null);
  const [voidFor, setVoidFor] = useState<Batch | null>(null);
  const [detail, setDetail] = useState<Batch | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['cutting'],
    queryFn: () => api.get<{ items: Batch[] }>('/api/cutting'),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['cutting'] });
    void queryClient.invalidateQueries({ queryKey: ['purchases'] });
    void queryClient.invalidateQueries({ queryKey: ['stock'] });
    void queryClient.invalidateQueries({ queryKey: ['products'] });
  };

  const doDelete = useMutation({
    mutationFn: (id: number) => api.delete(`/api/cutting/${id}`),
    onSuccess: () => {
      setDeleteBatch(null);
      invalidate();
    },
  });

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Cutting</h1>
          <p className="text-sm text-gray-500">
            The code number is given here — each size line carries its code and photo
          </p>
        </div>
        {canWrite && <Button onClick={() => setPlanOpen(true)}>+ New cutting</Button>}
      </div>

      <DataTable
        columns={[
          { key: 'docNo', header: 'Batch', className: 'font-mono text-xs font-medium' },
          {
            key: 'cutDate',
            header: 'Date',
            render: (r) => formatBusinessDate(r.cutDate),
            value: (r) => r.cutDate,
          },
          { key: 'rawDocNo', header: 'Cloth batch', className: 'font-mono text-xs' },
          {
            key: 'lines',
            header: 'Size-codes',
            render: (r) => (
              <span className="text-sm">
                {r.lines.map((l) => l.sizeCodeLabel).join(', ')} · {r.colorName}
              </span>
            ),
            value: (r) => r.lines.map((l) => l.sizeCodeLabel).join(', '),
          },
          {
            key: 'totalPcs',
            header: 'Pieces cut',
            render: (r) => <span className="font-medium">{formatPieces(r.totalPcs)}</span>,
            value: (r) => r.totalPcs,
          },
          {
            key: 'consumedInchC',
            // register color code: blue = cloth going out of the store
            header: 'Cloth used',
            render: (r) => <span className="font-medium text-blue-700">{formatLen(r.consumedInchC)}</span>,
            value: (r) => r.consumedInchC,
          },
          {
            key: 'status',
            header: 'Status',
            render: (r) =>
              r.voidedAt ? (
                <Badge tone="red">deleted</Badge>
              ) : r.editable ? (
                <Badge tone="green">editable</Badge>
              ) : (
                <Badge tone="gray">in use downstream</Badge>
              ),
          },
        ]}
        rows={data?.items}
        loading={isLoading}
        emptyTitle="Nothing cut yet"
        emptyHint={canWrite ? 'Press “+ New cutting” to record the first batch.' : undefined}
        facets={[{ key: 'color', label: 'Color', value: (r) => r.colorName }]}
        dateRange={{ label: 'Cut date', value: (r) => r.cutDate }}
        actions={(row) => {
          if (row.voidedAt)
            return (
              <Button variant="ghost" onClick={() => setDetail(row)}>
                Open
              </Button>
            );
          return (
            <div className="flex justify-end gap-1">
              <Button variant="ghost" onClick={() => setDetail(row)}>
                Open
              </Button>
              {canWrite && row.editable && (
                <>
                  <Button variant="ghost" onClick={() => setEditBatch(row)}>
                    Edit
                  </Button>
                  <Button variant="ghost" className="text-red-600" onClick={() => setDeleteBatch(row)}>
                    Delete
                  </Button>
                </>
              )}
              {isAdmin && !row.editable && (
                <Button variant="ghost" className="text-red-600" onClick={() => setVoidFor(row)}>
                  Void
                </Button>
              )}
            </div>
          );
        }}
      />

      <PlanModal
        key={`new-${String(planOpen)}`}
        open={planOpen}
        batch={null}
        onClose={() => setPlanOpen(false)}
        onDone={invalidate}
      />
      <PlanModal
        key={`edit-${editBatch?.id ?? 'none'}`}
        open={!!editBatch}
        batch={editBatch}
        onClose={() => setEditBatch(null)}
        onDone={invalidate}
      />

      <Modal
        title={`Delete ${deleteBatch?.docNo ?? ''}?`}
        open={!!deleteBatch}
        onClose={() => setDeleteBatch(null)}
      >
        <div className="space-y-4">
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            The cloth this batch used ({deleteBatch ? formatLen(deleteBatch.consumedInchC) : ''})
            goes back to batch {deleteBatch?.rawDocNo}, and its cut pieces are removed. The
            entry stays in history as deleted.
          </p>
          <Button
            variant="danger"
            className="w-full"
            disabled={doDelete.isPending}
            onClick={() => deleteBatch && doDelete.mutate(deleteBatch.id)}
          >
            {doDelete.isPending ? 'Deleting…' : 'Delete cutting entry'}
          </Button>
        </div>
      </Modal>

      <VoidModal
        entity="cutting batch"
        target={voidFor ? { id: voidFor.id, label: voidFor.docNo, url: `/api/cutting/${voidFor.id}/void` } : null}
        onClose={() => setVoidFor(null)}
        onDone={invalidate}
      />

      <Modal title={`${detail?.docNo ?? ''} — detail`} open={!!detail} onClose={() => setDetail(null)} wide>
        {detail && (
          <div className="space-y-3">
            <p className="text-sm text-gray-600">
              Cut on {formatBusinessDate(detail.cutDate)} from cloth batch{' '}
              <span className="font-mono">{detail.rawDocNo}</span> · {detail.colorName} ·{' '}
              <span className="font-medium text-blue-700">{formatLen(detail.consumedInchC)}</span> used
            </p>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-gray-400">
                  <th className="py-1.5">Size-code</th>
                  <th>Photo</th>
                  <th>Pieces</th>
                  <th>Cloth/pc</th>
                  <th>Across width</th>
                  <th>Still in stock</th>
                </tr>
              </thead>
              <tbody>
                {detail.lines.map((l) => (
                  <tr key={l.id} className="border-b border-gray-100">
                    <td className="py-1.5 font-medium">{l.sizeCodeLabel}</td>
                    <td>
                      {l.imagePath ? (
                        <ThumbLink href={l.imagePath} label="view" title="Product photo" />
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>{formatPieces(l.qtyPcs)}</td>
                    <td>{l.clothPerPcInchC ? formatInchC(l.clothPerPcInchC) : '—'}</td>
                    <td>{l.widthCount ?? '—'}</td>
                    <td>{formatPieces(l.remainingPcs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {detail.notes && <p className="text-sm text-gray-500">Notes: {detail.notes}</p>}
          </div>
        )}
      </Modal>
    </div>
  );
}

type PlanLine = {
  sizeId: number | null;
  code: string;
  pcs: number | null;
  clothPerPcInchC: number | null;
  widthCount: string;
  imagePath: string | null;
};

const EMPTY_LINE: PlanLine = { sizeId: null, code: '', pcs: null, clothPerPcInchC: null, widthCount: '', imagePath: null };

function PlanModal({
  open,
  batch,
  onClose,
  onDone,
}: {
  open: boolean;
  batch: Batch | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [cutDate, setCutDate] = useState(batch?.cutDate ?? todayIST());
  const [lotKey, setLotKey] = useState(batch ? `${batch.rawLotType}-${batch.rawLotId}` : '');
  const [notes, setNotes] = useState(batch?.notes ?? '');
  const [lines, setLines] = useState<PlanLine[]>(
    batch
      ? batch.lines.map((l) => ({
          sizeId: l.sizeId,
          code: l.code ?? '',
          pcs: l.qtyPcs,
          clothPerPcInchC: l.clothPerPcInchC,
          widthCount: String(l.widthCount ?? ''),
          imagePath: l.imagePath,
        }))
      : [{ ...EMPTY_LINE }],
  );
  const [error, setError] = useState('');

  const { data: rawData } = useQuery({
    queryKey: ['stock', 'raw-lots'],
    queryFn: () => api.get<{ lots: RawLot[] }>('/api/stock/raw'),
    enabled: open,
  });
  const lots = rawData?.lots ?? [];
  const selectedLot = lots.find((l) => `${l.lotType}-${l.lotId}` === lotKey) ?? null;

  const lineCost = (l: PlanLine): number =>
    l.pcs && l.clothPerPcInchC && Number(l.widthCount) > 0
      ? clothRequiredInchC(l.pcs, l.clothPerPcInchC, Number(l.widthCount))
      : 0;
  const requiredInchC = lines.reduce((s, l) => s + lineCost(l), 0);

  // when editing on the SAME lot, the batch's own cloth comes back first
  const lotAvailable = useMemo(() => {
    if (!selectedLot) return 0;
    const own =
      batch && `${batch.rawLotType}-${batch.rawLotId}` === lotKey ? batch.consumedInchC : 0;
    return selectedLot.qtyInchC + own;
  }, [selectedLot, batch, lotKey]);
  const remaining = lotAvailable - requiredInchC;

  const save = useMutation({
    mutationFn: () => {
      const [lotType, lotId] = lotKey.split('-');
      const payload = {
        cutDate,
        rawLotType: lotType as 'purchase' | 'opening',
        rawLotId: Number(lotId),
        notes,
        lines: lines.map((l) => ({
          sizeId: l.sizeId,
          code: l.code.trim().toUpperCase(),
          qtyPcs: l.pcs,
          clothPerPcInchC: l.clothPerPcInchC,
          widthCount: Number(l.widthCount),
          imagePath: l.imagePath,
        })),
      };
      return batch ? api.put(`/api/cutting/${batch.id}`, payload) : api.post('/api/cutting', payload);
    },
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Save failed.'),
  });

  return (
    <Modal
      title={batch ? `Edit cutting ${batch.docNo}` : 'New cutting'}
      open={open}
      onClose={onClose}
      wide
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!lotKey) {
            setError('Pick the cloth batch being cut.');
            return;
          }
          for (const l of lines) {
            if (!l.sizeId || !l.code.trim() || !l.pcs || !l.clothPerPcInchC || !Number(l.widthCount)) {
              setError('Every line needs size, code number, pieces, cloth per piece and pieces across the width.');
              return;
            }
          }
          if (remaining < 0) {
            setError('This cutting needs more cloth than the batch has left.');
            return;
          }
          save.mutate();
        }}
        className="space-y-4"
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Cut date">
            <TextInput type="date" value={cutDate} onChange={(e) => setCutDate(e.target.value)} required />
          </Field>
          <Field label="Cloth batch" hint={selectedLot?.widthInchC ? `Cloth width ${formatInchC(selectedLot.widthInchC)}` : undefined}>
            <Select value={lotKey} onChange={(e) => setLotKey(e.target.value)}>
              <option value="" disabled>
                — select the roll being cut —
              </option>
              {/* the cutter recognises a roll by its colour and how much is left — batch
                  numbers are bookkeeping and only made this list harder to read */}
              {lots.map((l) => (
                <option key={`${l.lotType}-${l.lotId}`} value={`${l.lotType}-${l.lotId}`}>
                  {l.colorName} · {formatLen(l.qtyInchC)} left
                  {l.widthInchC ? ` · ${formatInchC(l.widthInchC)} wide` : ''}
                </option>
              ))}
              {batch && !lots.some((l) => `${l.lotType}-${l.lotId}` === lotKey) && (
                <option value={lotKey}>{batch.colorName} · the roll already being cut</option>
              )}
            </Select>
          </Field>
          <Field label="Notes">
            <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium text-gray-700">
            Sizes cut — type the CODE NUMBER beside each size (that becomes the size-code)
          </p>
          <div className="space-y-3">
            {lines.map((line, i) => (
              <div key={i} className="rounded-xl border border-gray-200 p-3">
                <div className="flex flex-wrap items-end gap-2">
                  <div className="w-24">
                    <Field label="Size">
                      <MasterSelect
                        master="sizes"
                        value={line.sizeId}
                        onChange={(v) => {
                          const next = [...lines];
                          next[i] = { ...line, sizeId: v };
                          setLines(next);
                        }}
                      />
                    </Field>
                  </div>
                  <div className="w-28">
                    <Field label="Code no.">
                      <TextInput
                        aria-label={`Code ${i + 1}`}
                        value={line.code}
                        placeholder="e.g. 315"
                        onChange={(e) => {
                          const next = [...lines];
                          next[i] = { ...line, code: e.target.value };
                          setLines(next);
                        }}
                      />
                    </Field>
                  </div>
                  <div className="w-44">
                    <Field label="Pieces cut">
                      <DzPcInput
                        pieces={line.pcs}
                        onChange={(v) => {
                          const next = [...lines];
                          next[i] = { ...line, pcs: v };
                          setLines(next);
                        }}
                      />
                    </Field>
                  </div>
                  <div className="w-28">
                    <Field label="Cloth/pc">
                      <InchesInput
                        ariaLabel={`Cloth per piece ${i + 1}`}
                        inchC={line.clothPerPcInchC}
                        onChange={(v) => {
                          const next = [...lines];
                          next[i] = { ...line, clothPerPcInchC: v };
                          setLines(next);
                        }}
                        placeholder="10"
                      />
                    </Field>
                  </div>
                  <div className="w-24">
                    <Field label="Across width">
                      <TextInput
                        aria-label={`Pieces across width ${i + 1}`}
                        inputMode="numeric"
                        value={line.widthCount}
                        placeholder="3"
                        onChange={(e) => {
                          if (!/^\d{0,4}$/.test(e.target.value)) return;
                          const next = [...lines];
                          next[i] = { ...line, widthCount: e.target.value };
                          setLines(next);
                        }}
                      />
                    </Field>
                  </div>
                  <div className="ml-auto pb-1 text-right text-sm text-gray-500">
                    {lineCost(line) > 0 && <>uses {formatLen(lineCost(line))}</>}
                  </div>
                  {lines.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      className="text-red-500"
                      onClick={() => setLines(lines.filter((_, j) => j !== i))}
                    >
                      ✕
                    </Button>
                  )}
                </div>
                <div className="mt-2">
                  <Field label="Photo of this product (shown everywhere this code appears)">
                    <ImageInput
                      path={line.imagePath}
                      onChange={(p) => {
                        const next = [...lines];
                        next[i] = { ...line, imagePath: p };
                        setLines(next);
                      }}
                    />
                  </Field>
                </div>
              </div>
            ))}
          </div>
          <Button type="button" variant="secondary" className="mt-2" onClick={() => setLines([...lines, { ...EMPTY_LINE }])}>
            + Add size
          </Button>
        </div>

        <div className="rounded-xl bg-gray-50 px-4 py-3 text-sm">
          <div className="flex flex-wrap gap-x-8 gap-y-1">
            <span>
              Cloth needed: <strong className="text-blue-700">{formatLen(requiredInchC)}</strong>
            </span>
            <span>
              Batch has: <strong>{formatLen(lotAvailable)}</strong>
            </span>
            <span>
              Left after cutting:{' '}
              <strong className={remaining < 0 ? 'text-red-600' : 'text-emerald-700'}>
                {formatLen(remaining)}
              </strong>
            </span>
          </div>
        </div>

        <ErrorText>{error}</ErrorText>
        <Button type="submit" disabled={save.isPending} className="w-full">
          {save.isPending ? 'Saving…' : batch ? 'Save changes' : 'Record cutting'}
        </Button>
      </form>
    </Modal>
  );
}
