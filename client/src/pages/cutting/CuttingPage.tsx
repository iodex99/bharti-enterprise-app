import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CUTTING_VARIANCE_REASONS,
  formatBusinessDate,
  formatCm,
  formatPieces,
  label as enumLabel,
  todayIST,
  variancePct,
} from '@shared';
import { api, ApiError } from '../../api/client';
import { useAuth } from '../../lib/auth';
import { DataTable } from '../../components/DataTable';
import { Badge, Button, ErrorText, Field, Modal, Select, TextInput } from '../../components/ui';
import { DzPcInput, MetersInput } from '../../components/inputs';
import { useMasterOptions } from '../../api/masters';
import { VoidModal } from '../purchases/PurchasesPage';

type CuttingLine = {
  id: number;
  sizeId: number;
  sizeCode: string;
  expectedPcs: number;
  actualPcs: number | null;
  varianceReason: string | null;
  reasonNote: string;
};

type CuttingBatch = {
  id: number;
  docNo: string;
  cutDate: string;
  status: 'planned' | 'completed';
  rawDocNo: string;
  modelCode: string;
  colorName: string;
  metersUsedCm: number;
  notes: string;
  voidedAt: string | null;
  lines: CuttingLine[];
  expectedTotalPcs: number;
  actualTotalPcs: number | null;
  variancePct: number | null;
};

type RawLot = {
  lotType: 'purchase' | 'opening';
  lotId: number;
  modelCode: string;
  colorName: string;
  purchaseDocNo: string | null;
  openingDocNo: string | null;
  vendorName: string | null;
  qtyCm: number;
};

export default function CuttingPage() {
  const { user } = useAuth();
  const canWrite = user?.role === 'admin' || user?.role === 'operator';
  const isAdmin = user?.role === 'admin';
  const queryClient = useQueryClient();
  const [planOpen, setPlanOpen] = useState(false);
  const [actualsFor, setActualsFor] = useState<CuttingBatch | null>(null);
  const [voidFor, setVoidFor] = useState<CuttingBatch | null>(null);
  const [detailFor, setDetailFor] = useState<CuttingBatch | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['cutting'],
    queryFn: () => api.get<{ items: CuttingBatch[] }>('/api/cutting'),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['cutting'] });
    void queryClient.invalidateQueries({ queryKey: ['stock'] });
  };

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Cutting</h1>
          <p className="text-sm text-gray-500">
            Plan cutting from a cloth batch, then record the actual output (Modules 2–3)
          </p>
        </div>
        {canWrite && <Button onClick={() => setPlanOpen(true)}>+ New cutting plan</Button>}
      </div>

      <DataTable
        columns={[
          { key: 'docNo', header: 'Batch', className: 'font-mono text-xs font-medium' },
          { key: 'cutDate', header: 'Date', render: (r) => formatBusinessDate(r.cutDate) },
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
          { key: 'rawDocNo', header: 'Cloth batch', className: 'font-mono text-xs text-gray-500' },
          { key: 'metersUsedCm', header: 'Cloth used', render: (r) => formatCm(r.metersUsedCm) },
          {
            key: 'expected',
            header: 'Expected',
            render: (r) => formatPieces(r.expectedTotalPcs),
            value: (r) => r.expectedTotalPcs,
          },
          {
            key: 'actual',
            header: 'Actual',
            render: (r) =>
              r.actualTotalPcs == null ? (
                <span className="text-gray-300">—</span>
              ) : (
                formatPieces(r.actualTotalPcs)
              ),
          },
          {
            key: 'variance',
            header: 'Variance',
            render: (r) => <VarianceBadge batch={r} />,
          },
          {
            key: 'status',
            header: 'Status',
            render: (r) =>
              r.voidedAt ? (
                <Badge tone="red">voided</Badge>
              ) : r.status === 'completed' ? (
                <Badge tone="green">completed</Badge>
              ) : (
                <Badge tone="amber">planned</Badge>
              ),
          },
        ]}
        rows={data?.items}
        loading={isLoading}
        emptyTitle="No cutting batches yet"
        emptyHint={canWrite ? 'Press “+ New cutting plan” to plan the first cut.' : undefined}
        facets={[
          { key: 'status', label: 'Status', value: (r) => (r.voidedAt ? 'voided' : r.status) },
          { key: 'model', label: 'Model', value: (r) => r.modelCode },
          { key: 'color', label: 'Color', value: (r) => r.colorName },
        ]}
        dateRange={{ label: 'Cutting date', value: (r) => r.cutDate }}
        actions={(row) => (
          <>
            <Button variant="ghost" onClick={() => setDetailFor(row)}>
              Details
            </Button>
            {canWrite && row.status === 'planned' && !row.voidedAt && (
              <Button variant="ghost" className="text-violet-700" onClick={() => setActualsFor(row)}>
                Record actuals
              </Button>
            )}
            {isAdmin && !row.voidedAt && (
              <Button variant="ghost" className="text-red-600" onClick={() => setVoidFor(row)}>
                Void
              </Button>
            )}
          </>
        )}
      />

      <PlanModal key={String(planOpen)} open={planOpen} onClose={() => setPlanOpen(false)} onDone={invalidate} />
      <ActualsModal
        key={actualsFor?.id ?? 'none'}
        batch={actualsFor}
        onClose={() => setActualsFor(null)}
        onDone={invalidate}
      />
      <DetailModal batch={detailFor} onClose={() => setDetailFor(null)} />
      <VoidModal
        entity="cutting batch"
        target={voidFor ? { id: voidFor.id, label: voidFor.docNo, url: `/api/cutting/${voidFor.id}/void` } : null}
        onClose={() => setVoidFor(null)}
        onDone={invalidate}
      />
    </div>
  );
}

function VarianceBadge({ batch }: { batch: CuttingBatch }) {
  if (batch.variancePct == null) return <span className="text-gray-300">—</span>;
  if (batch.variancePct === 0) return <Badge tone="green">exact</Badge>;
  const tone = batch.variancePct < 0 ? 'red' : 'blue';
  return (
    <Badge tone={tone}>
      {batch.variancePct > 0 ? '+' : ''}
      {batch.variancePct}%
    </Badge>
  );
}

function PlanModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [cutDate, setCutDate] = useState(todayIST());
  const [rawKey, setRawKey] = useState('');
  const [metersUsedCm, setMeters] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Array<{ sizeId: number | null; expectedPcs: number | null }>>([
    { sizeId: null, expectedPcs: null },
  ]);
  const [error, setError] = useState('');
  const { data: sizes } = useMasterOptions('sizes');

  const { data: rawLots } = useQuery({
    queryKey: ['stock', 'raw'],
    queryFn: () => api.get<{ lots: RawLot[] }>('/api/stock/raw'),
    enabled: open,
  });

  const selectedLot = useMemo(
    () => rawLots?.lots.find((l) => `${l.lotType}-${l.lotId}` === rawKey),
    [rawLots, rawKey],
  );

  const save = useMutation({
    mutationFn: () =>
      api.post('/api/cutting', {
        cutDate,
        rawLotType: selectedLot!.lotType,
        rawLotId: selectedLot!.lotId,
        metersUsedCm,
        notes,
        lines: lines
          .filter((l) => l.sizeId && l.expectedPcs)
          .map((l) => ({ sizeId: l.sizeId, expectedPcs: l.expectedPcs })),
      }),
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Save failed.'),
  });

  const totalExpected = lines.reduce((s, l) => s + (l.expectedPcs ?? 0), 0);

  return (
    <Modal title="New cutting plan" open={open} onClose={onClose} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!selectedLot) {
            setError('Pick the cloth batch to cut.');
            return;
          }
          if (!metersUsedCm) {
            setError('Enter how many meters will be used.');
            return;
          }
          if (!lines.some((l) => l.sizeId && l.expectedPcs)) {
            setError('Add at least one size with an expected quantity.');
            return;
          }
          save.mutate();
        }}
        className="space-y-4"
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Cutting date">
            <TextInput type="date" value={cutDate} onChange={(e) => setCutDate(e.target.value)} required />
          </Field>
          <Field label="Cloth batch (raw material)">
            <Select value={rawKey} onChange={(e) => setRawKey(e.target.value)}>
              <option value="" disabled>
                — pick a batch —
              </option>
              {rawLots?.lots.map((l) => (
                <option key={`${l.lotType}-${l.lotId}`} value={`${l.lotType}-${l.lotId}`}>
                  {(l.purchaseDocNo ?? l.openingDocNo)!} · {l.modelCode} {l.colorName} ·{' '}
                  {formatCm(l.qtyCm)} available
                </option>
              ))}
            </Select>
          </Field>
          {selectedLot && (
            <div className="rounded-lg bg-violet-50 px-3 py-2 text-sm text-violet-900 sm:col-span-2">
              <strong>{selectedLot.modelCode}</strong> · {selectedLot.colorName} ·{' '}
              {formatCm(selectedLot.qtyCm)} available
              {selectedLot.vendorName ? ` · from ${selectedLot.vendorName}` : ''}
            </div>
          )}
          <Field label="Cloth to use (meters)">
            <MetersInput cm={metersUsedCm} onChange={setMeters} />
          </Field>
          <Field label="Notes">
            <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium text-gray-700">Expected output per size</p>
          <div className="space-y-2">
            {lines.map((line, i) => (
              <div key={i} className="flex items-end gap-2">
                <div className="w-36">
                  <Select
                    aria-label={`Size ${i + 1}`}
                    value={line.sizeId ?? ''}
                    onChange={(e) => {
                      const next = [...lines];
                      next[i] = { ...line, sizeId: e.target.value ? Number(e.target.value) : null };
                      setLines(next);
                    }}
                  >
                    <option value="" disabled>
                      Size
                    </option>
                    {sizes?.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.code as string}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="flex-1">
                  <DzPcInput
                    pieces={line.expectedPcs}
                    onChange={(pcs) => {
                      const next = [...lines];
                      next[i] = { ...line, expectedPcs: pcs };
                      setLines(next);
                    }}
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  className="text-red-500"
                  onClick={() => setLines(lines.filter((_, j) => j !== i))}
                  disabled={lines.length === 1}
                >
                  ✕
                </Button>
              </div>
            ))}
          </div>
          <div className="mt-2 flex items-center justify-between">
            <Button type="button" variant="secondary" onClick={() => setLines([...lines, { sizeId: null, expectedPcs: null }])}>
              + Add size
            </Button>
            <span className="text-sm text-gray-500">
              Total expected: <strong>{formatPieces(totalExpected)}</strong>
            </span>
          </div>
        </div>

        <ErrorText>{error}</ErrorText>
        <Button type="submit" disabled={save.isPending} className="w-full">
          {save.isPending ? 'Saving…' : 'Save cutting plan'}
        </Button>
      </form>
    </Modal>
  );
}

function ActualsModal({
  batch,
  onClose,
  onDone,
}: {
  batch: CuttingBatch | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [actuals, setActuals] = useState<
    Array<{ sizeId: number; sizeCode: string; expectedPcs: number; actualPcs: number | null; varianceReason: string; reasonNote: string }>
  >(() =>
    (batch?.lines ?? []).map((l) => ({
      sizeId: l.sizeId,
      sizeCode: l.sizeCode,
      expectedPcs: l.expectedPcs,
      actualPcs: null,
      varianceReason: '',
      reasonNote: '',
    })),
  );
  const [extraSizeId, setExtraSizeId] = useState<number | null>(null);
  const [error, setError] = useState('');
  const { data: sizes } = useMasterOptions('sizes');

  const save = useMutation({
    mutationFn: () =>
      api.post(`/api/cutting/${batch!.id}/actuals`, {
        lines: actuals.map((a) => ({
          sizeId: a.sizeId,
          actualPcs: a.actualPcs ?? 0,
          varianceReason: a.varianceReason || null,
          reasonNote: a.reasonNote,
        })),
      }),
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Save failed.'),
  });

  if (!batch) return null;
  const usedSizeIds = new Set(actuals.map((a) => a.sizeId));

  return (
    <Modal title={`Record actuals — ${batch.docNo}`} open={!!batch} onClose={onClose} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="space-y-4"
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[540px] text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-400">
                <th className="py-2 pr-2">Size</th>
                <th className="py-2 pr-2">Expected</th>
                <th className="py-2 pr-2">Actual</th>
                <th className="py-2 pr-2">Difference</th>
                <th className="py-2">Reason</th>
              </tr>
            </thead>
            <tbody>
              {actuals.map((a, i) => {
                const diff = (a.actualPcs ?? 0) - a.expectedPcs;
                const pct = a.actualPcs == null ? null : variancePct(a.expectedPcs, a.actualPcs);
                return (
                  <tr key={a.sizeId} className="border-b border-gray-100 align-top last:border-0">
                    <td className="py-2 pr-2 font-medium">{a.sizeCode}</td>
                    <td className="py-2 pr-2 text-gray-500">{formatPieces(a.expectedPcs)}</td>
                    <td className="py-2 pr-2">
                      <div className="w-44">
                        <DzPcInput
                          pieces={a.actualPcs}
                          onChange={(pcs) => {
                            const next = [...actuals];
                            next[i] = { ...a, actualPcs: pcs };
                            setActuals(next);
                          }}
                        />
                      </div>
                    </td>
                    <td className="py-2 pr-2">
                      {a.actualPcs == null ? (
                        <span className="text-gray-300">—</span>
                      ) : diff === 0 ? (
                        <Badge tone="green">exact</Badge>
                      ) : (
                        <Badge tone={diff < 0 ? 'red' : 'blue'}>
                          {diff > 0 ? '+' : ''}
                          {formatPieces(diff)} ({pct! > 0 ? '+' : ''}
                          {pct}%)
                        </Badge>
                      )}
                    </td>
                    <td className="py-2">
                      {diff !== 0 && a.actualPcs != null && (
                        <div className="space-y-1">
                          <Select
                            aria-label={`Reason for ${a.sizeCode}`}
                            value={a.varianceReason}
                            onChange={(e) => {
                              const next = [...actuals];
                              next[i] = { ...a, varianceReason: e.target.value };
                              setActuals(next);
                            }}
                          >
                            <option value="">— reason —</option>
                            {CUTTING_VARIANCE_REASONS.map((r) => (
                              <option key={r} value={r}>
                                {enumLabel(r)}
                              </option>
                            ))}
                          </Select>
                          <TextInput
                            placeholder="Note (optional)"
                            value={a.reasonNote}
                            onChange={(e) => {
                              const next = [...actuals];
                              next[i] = { ...a, reasonNote: e.target.value };
                              setActuals(next);
                            }}
                          />
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="flex items-center gap-2">
          <Select
            aria-label="Add unplanned size"
            value={extraSizeId ?? ''}
            onChange={(e) => setExtraSizeId(e.target.value ? Number(e.target.value) : null)}
            className="w-40"
          >
            <option value="">Unplanned size…</option>
            {sizes
              ?.filter((s) => !usedSizeIds.has(s.id))
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code as string}
                </option>
              ))}
          </Select>
          <Button
            type="button"
            variant="secondary"
            disabled={!extraSizeId}
            onClick={() => {
              const size = sizes?.find((s) => s.id === extraSizeId);
              if (!size) return;
              setActuals([
                ...actuals,
                {
                  sizeId: size.id,
                  sizeCode: size.code as string,
                  expectedPcs: 0,
                  actualPcs: null,
                  varianceReason: '',
                  reasonNote: '',
                },
              ]);
              setExtraSizeId(null);
            }}
          >
            + Add
          </Button>
          <span className="ml-auto text-xs text-gray-400">
            A reason is required wherever actual ≠ expected
          </span>
        </div>

        <ErrorText>{error}</ErrorText>
        <Button type="submit" disabled={save.isPending} className="w-full">
          {save.isPending ? 'Saving…' : 'Complete cutting'}
        </Button>
      </form>
    </Modal>
  );
}

function DetailModal({ batch, onClose }: { batch: CuttingBatch | null; onClose: () => void }) {
  if (!batch) return null;
  return (
    <Modal title={`${batch.docNo} — details`} open={!!batch} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p className="text-gray-500">
          {formatBusinessDate(batch.cutDate)} · {batch.modelCode} {batch.colorName} · cloth{' '}
          {batch.rawDocNo} · {formatCm(batch.metersUsedCm)} used
        </p>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-400">
              <th className="py-1.5">Size</th>
              <th className="py-1.5">Expected</th>
              <th className="py-1.5">Actual</th>
              <th className="py-1.5">Reason</th>
            </tr>
          </thead>
          <tbody>
            {batch.lines.map((l) => (
              <tr key={l.id} className="border-b border-gray-100 last:border-0">
                <td className="py-1.5 font-medium">{l.sizeCode}</td>
                <td className="py-1.5">{formatPieces(l.expectedPcs)}</td>
                <td className="py-1.5">{l.actualPcs == null ? '—' : formatPieces(l.actualPcs)}</td>
                <td className="py-1.5 text-gray-500">
                  {l.varianceReason ? enumLabel(l.varianceReason) : '—'}
                  {l.reasonNote ? ` (${l.reasonNote})` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {batch.notes && <p className="text-gray-500">Notes: {batch.notes}</p>}
      </div>
    </Modal>
  );
}
