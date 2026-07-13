import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatBusinessDate, formatPieces, istDateOf, label as enumLabel } from '@shared';
import { api, ApiError } from '../../api/client';
import { useAuth } from '../../lib/auth';
import { DataTable } from '../../components/DataTable';
import { Badge, Button, ErrorText, Field, Modal, TextInput } from '../../components/ui';

type Discrepancy = {
  id: number;
  createdAt: string;
  stage: string;
  docNo: string | null;
  party: string;
  item: string | null;
  qtyPcs: number;
  reason: string;
  note: string;
  resolvedAt: string | null;
  resolvedByName: string | null;
  resolutionNote: string;
};

/**
 * Review queue for every recorded difference (cutting variance, job excess/shortage,
 * checking missing/rejected, packing short). Resolving is an acknowledgement — the
 * stock effect already happened when the difference was recorded.
 */
export default function DiscrepanciesPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const queryClient = useQueryClient();
  const [resolveFor, setResolveFor] = useState<Discrepancy | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['discrepancies'],
    queryFn: () => api.get<{ items: Discrepancy[] }>('/api/discrepancies'),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['discrepancies'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4">
        <h1 className="text-xl font-bold text-gray-900">Discrepancies</h1>
        <p className="text-sm text-gray-500">
          Every recorded difference between expected and actual — and how it was settled
        </p>
      </div>

      <DataTable
        columns={[
          {
            key: 'date',
            header: 'Date',
            value: (r) => istDateOf(r.createdAt),
            render: (r) => formatBusinessDate(istDateOf(r.createdAt)),
          },
          {
            key: 'docNo',
            header: 'Doc',
            className: 'font-mono text-xs font-medium',
            render: (r) => r.docNo ?? '—',
          },
          { key: 'stage', header: 'Stage' },
          { key: 'item', header: 'Item', render: (r) => r.item ?? '—' },
          { key: 'party', header: 'Contractor / staff', render: (r) => r.party || '—' },
          {
            key: 'qtyPcs',
            header: 'Difference',
            render: (r) =>
              r.qtyPcs < 0 ? (
                <Badge tone="red">− {formatPieces(-r.qtyPcs)}</Badge>
              ) : (
                <Badge tone="amber">+ {formatPieces(r.qtyPcs)}</Badge>
              ),
          },
          { key: 'reason', header: 'Reason', value: (r) => enumLabel(r.reason), render: (r) => enumLabel(r.reason) },
          { key: 'note', header: 'Note', className: 'max-w-[16rem] truncate text-gray-500' },
          {
            key: 'status',
            header: 'Status',
            value: (r) => (r.resolvedAt ? 'resolved' : 'unresolved'),
            render: (r) =>
              r.resolvedAt ? (
                <span title={`${r.resolutionNote} — ${r.resolvedByName ?? ''}, ${formatBusinessDate(istDateOf(r.resolvedAt))}`}>
                  <Badge tone="green">resolved</Badge>
                </span>
              ) : (
                <Badge tone="amber">unresolved</Badge>
              ),
          },
        ]}
        rows={data?.items}
        loading={isLoading}
        emptyTitle="No discrepancies recorded"
        emptyHint="Cutting variances, excess or short receipts, and missing/rejected pieces all appear here automatically."
        facets={[
          { key: 'stage', label: 'Stage', value: (r) => r.stage },
          { key: 'status', label: 'Status', value: (r) => (r.resolvedAt ? 'resolved' : 'unresolved') },
          { key: 'reason', label: 'Reason', value: (r) => enumLabel(r.reason) },
        ]}
        dateRange={{ label: 'Recorded date', value: (r) => istDateOf(r.createdAt) }}
        actions={
          isAdmin
            ? (row) =>
                row.resolvedAt ? null : (
                  <Button variant="ghost" className="text-violet-700" onClick={() => setResolveFor(row)}>
                    Resolve
                  </Button>
                )
            : undefined
        }
      />

      <ResolveModal
        key={resolveFor?.id ?? 'none'}
        target={resolveFor}
        onClose={() => setResolveFor(null)}
        onDone={invalidate}
      />
    </div>
  );
}

function ResolveModal({
  target,
  onClose,
  onDone,
}: {
  target: Discrepancy | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  const save = useMutation({
    mutationFn: () => api.post(`/api/discrepancies/${target!.id}/resolve`, { note }),
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Save failed.'),
  });

  if (!target) return null;
  return (
    <Modal title="Resolve discrepancy" open onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="space-y-4"
      >
        <div className="rounded-xl bg-gray-50 p-3 text-sm text-gray-600">
          <span className="font-mono text-xs font-medium">{target.docNo ?? '—'}</span> · {target.stage} ·{' '}
          {target.item ?? '—'} ·{' '}
          <span className="font-semibold">
            {target.qtyPcs < 0 ? `− ${formatPieces(-target.qtyPcs)}` : `+ ${formatPieces(target.qtyPcs)}`}
          </span>{' '}
          ({enumLabel(target.reason)})
        </div>
        <Field label="Resolution note" hint="What was decided or settled — e.g. recovered from contractor, written off, counting error confirmed">
          <TextInput value={note} onChange={(e) => setNote(e.target.value)} required minLength={3} maxLength={500} />
        </Field>
        <p className="text-xs text-gray-400">
          Resolving records your review — stock has already been adjusted and is not changed again.
        </p>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" disabled={save.isPending} className="w-full">
          {save.isPending ? 'Saving…' : 'Mark resolved'}
        </Button>
      </form>
    </Modal>
  );
}
