import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CHECK_REJECTION_REASONS,
  PACK_SHORT_REASONS,
  formatBusinessDate,
  formatPaise,
  formatPieces,
  label as enumLabel,
  todayIST,
} from '@shared';
import { api, ApiError } from '../../api/client';
import { useAuth } from '../../lib/auth';
import { DataTable } from '../../components/DataTable';
import {
  Badge,
  Button,
  EmptyState,
  ErrorText,
  Field,
  MiniTable,
  Modal,
  PageHeader,
  PhotoThumb,
  Select,
  Tabs,
  TextInput,
} from '../../components/ui';
import { DzPcInput, MoneyInput } from '../../components/inputs';
import { useMasterOptions } from '../../api/masters';
import { VoidModal } from '../purchases/PurchasesPage';

/**
 * Checking & Packing (ADR-034/035/046). One page, four steps as tabs:
 *   To check  — goods back from contractors, waiting for a checker
 *   Checking  — with a checker; record passed / rejected (rejected go straight back to
 *               the contractor for rework; missing is deducted from them)
 *   Packing   — passed pieces to pack (usually by the checker), packing in progress,
 *               bundles kept aside
 *   Packed    — the register of finished goods: what was packed, by whom, when
 */

type CheckIssue = {
  id: number;
  docNo: string;
  issueDate: string;
  status: 'open' | 'completed';
  staffId: number;
  staffName: string;
  code: string;
  sizeCodeLabel: string;
  codeImagePath: string | null;
  colorName: string;
  sizeCode: string;
  qtyPcs: number;
  ratePaisePerDozen: number;
  notes: string;
  passedPcs: number;
  rejectedPcs: number;
  missingPcs: number;
  pendingPcs: number;
  packablePcs: number;
  sentBackPcs: number;
  hasResults: boolean;
  voidedAt: string | null;
  contractorName: string | null;
  receiptDocNo: string | null;
  receiptImagePath: string | null;
};

/** A received-but-unchecked batch (the contractor's claim, waiting for verification). */
type PendingBatch = {
  lotType: 'receipt_line' | 'opening';
  lotId: number;
  qtyPcs: number;
  sizeCodeLabel: string;
  codeImagePath: string | null;
  colorName: string;
  sizeCode: string;
  receiptDocNo: string | null;
  receiptDate: string | null;
  imagePath: string | null;
  jobDocNo: string | null;
  contractorName: string | null;
  openingDocNo: string | null;
};

type PackIssue = {
  id: number;
  docNo: string;
  issueDate: string;
  status: 'open' | 'completed';
  staffId: number;
  staffName: string;
  kind: 'pack' | 'bundle';
  label: string;
  notes: string;
  ratePaisePerDozen: number;
  sizeCodeLabel: string;
  codeImagePath: string | null;
  colorName: string;
  qtyPcs: number;
  packedPcs: number;
  shortPcs: number;
  heldPcs: number;
  voidedAt: string | null;
};

type PackedRow = {
  id: number;
  packedDate: string;
  packedPcs: number;
  shortPcs: number;
  shortReason: string | null;
  docNo: string;
  kind: 'pack' | 'bundle';
  label: string;
  staffName: string;
  sizeCodeLabel: string;
  codeImagePath: string | null;
  colorName: string;
  checkDocNo: string | null;
  contractorName: string | null;
};

type Tab = 'tocheck' | 'checking' | 'packing' | 'packed';

export default function CheckingPage() {
  const { user } = useAuth();
  const canWrite = user?.role === 'admin' || user?.role === 'operator';
  const isAdmin = user?.role === 'admin';
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const tab = (
    ['tocheck', 'checking', 'packing', 'packed'].includes(params.get('tab') ?? '')
      ? params.get('tab')
      : 'tocheck'
  ) as Tab;
  const setTab = (t: Tab) => setParams({ tab: t }, { replace: true });

  const [issueFor, setIssueFor] = useState<PendingBatch | null>(null);
  const [resultFor, setResultFor] = useState<CheckIssue | null>(null);
  const [packFor, setPackFor] = useState<CheckIssue | null>(null);
  const [packResultFor, setPackResultFor] = useState<PackIssue | null>(null);
  const [editCheck, setEditCheck] = useState<CheckIssue | null>(null);
  const [editPack, setEditPack] = useState<PackIssue | null>(null);
  const [voidFor, setVoidFor] = useState<CheckIssue | null>(null);
  const [voidPack, setVoidPack] = useState<PackIssue | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['checking'],
    queryFn: () => api.get<{ items: CheckIssue[] }>('/api/checking'),
  });
  const { data: pending } = useQuery({
    queryKey: ['checking', 'pending'],
    queryFn: () => api.get<{ items: PendingBatch[] }>('/api/checking/pending'),
  });
  const { data: packing } = useQuery({
    queryKey: ['packing'],
    queryFn: () => api.get<{ items: PackIssue[] }>('/api/packing'),
  });
  const { data: packed, isLoading: packedLoading } = useQuery({
    queryKey: ['packing', 'packed'],
    queryFn: () => api.get<{ items: PackedRow[] }>('/api/packing/packed'),
    enabled: tab === 'packed',
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['checking'] });
    void queryClient.invalidateQueries({ queryKey: ['packing'] });
    void queryClient.invalidateQueries({ queryKey: ['stock'] });
    void queryClient.invalidateQueries({ queryKey: ['jobs'] });
    void queryClient.invalidateQueries({ queryKey: ['contractors'] });
    void queryClient.invalidateQueries({ queryKey: ['staff'] });
  };

  const issues = data?.items ?? [];
  const withChecker = issues.filter((i) => i.status === 'open').length;
  const readyToPack = issues.filter((i) => i.packablePcs > 0);
  const bundles = packing?.items.filter((p) => p.kind === 'bundle' && p.heldPcs > 0) ?? [];
  const packWork = packing?.items.filter((p) => p.kind === 'pack' && p.status === 'open') ?? [];

  return (
    <div className="p-4 sm:p-6">
      <PageHeader
        title="Checking & Packing"
        subtitle="Returned goods count only after checking — and the checker usually packs them too"
      />

      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { key: 'tocheck', label: '📥 To check', count: pending?.items.length, tone: 'amber' },
          { key: 'checking', label: '🔍 Checking', count: withChecker, tone: 'amber' },
          {
            key: 'packing',
            label: '📦 Packing',
            count: readyToPack.length + packWork.length + bundles.length,
            tone: 'amber',
          },
          { key: 'packed', label: '✅ Packed' },
        ]}
      />

      {tab === 'tocheck' && (
        <section>
          <p className="mb-3 text-sm text-gray-500">
            Received from contractors but not yet verified — give each batch to a checker.
          </p>
          {pending && pending.items.length === 0 && (
            <EmptyState title="Nothing waiting" hint="Every received batch is with a checker." />
          )}
          {pending && pending.items.length > 0 && (
            <MiniTable
              rows={pending.items}
              keyOf={(b) => `${b.lotType}-${b.lotId}`}
              columns={[
                {
                  header: 'Photo',
                  render: (b) => (
                    <PhotoThumb
                      src={b.imagePath ?? b.codeImagePath}
                      title={`Returned goods ${b.receiptDocNo ?? ''}`}
                    />
                  ),
                },
                {
                  header: 'From',
                  className: 'font-medium',
                  render: (b) => b.contractorName ?? 'Opening stock',
                },
                {
                  header: 'Received',
                  className: 'text-gray-500',
                  render: (b) => (b.receiptDate ? formatBusinessDate(b.receiptDate) : '—'),
                },
                {
                  header: 'Receipt',
                  className: 'font-mono text-xs text-gray-500',
                  render: (b) => b.receiptDocNo ?? b.openingDocNo ?? '—',
                },
                {
                  header: 'Size-code',
                  render: (b) => (
                    <span>
                      <span className="font-medium">{b.sizeCodeLabel}</span>{' '}
                      <span className="text-gray-500">{b.colorName}</span>
                    </span>
                  ),
                },
                {
                  header: 'Waiting',
                  render: (b) => (
                    <span className="font-semibold text-red-700">{formatPieces(b.qtyPcs)}</span>
                  ),
                },
              ]}
              actions={
                canWrite
                  ? (b) => (
                      <Button
                        variant="ghost"
                        className="text-violet-700"
                        onClick={() => setIssueFor(b)}
                      >
                        Issue to checker
                      </Button>
                    )
                  : undefined
              }
            />
          )}
        </section>
      )}

      {tab === 'checking' && (
        <DataTable
          columns={[
            { key: 'docNo', header: 'Doc', className: 'font-mono text-xs font-medium' },
            { key: 'issueDate', header: 'Date', render: (r) => formatBusinessDate(r.issueDate) },
            { key: 'staffName', header: 'Checker' },
            {
              key: 'contractorName',
              header: 'From contractor',
              value: (r) => r.contractorName ?? '',
              render: (r) =>
                r.contractorName ? (
                  <span className="inline-flex items-center gap-2">
                    {r.receiptImagePath && (
                      <PhotoThumb
                        src={r.receiptImagePath}
                        title={`Returned goods ${r.receiptDocNo ?? ''}`}
                        size={32}
                      />
                    )}
                    <span>
                      {r.contractorName}{' '}
                      {r.receiptDocNo && (
                        <span className="font-mono text-xs text-gray-400">({r.receiptDocNo})</span>
                      )}
                    </span>
                  </span>
                ) : (
                  <span className="text-gray-300">—</span>
                ),
            },
            {
              key: 'item',
              header: 'Size-code',
              value: (r) => `${r.sizeCodeLabel} ${r.colorName}`,
              render: (r) => (
                <span>
                  <span className="font-medium">{r.sizeCodeLabel}</span>{' '}
                  <span className="text-gray-500">{r.colorName}</span>
                </span>
              ),
            },
            {
              key: 'qtyPcs',
              header: 'Issued',
              // register color code: blue = goods issued out (to the checker)
              render: (r) => <Badge tone="blue">{formatPieces(r.qtyPcs)}</Badge>,
              value: (r) => r.qtyPcs,
            },
            {
              key: 'progress',
              header: 'Passed / Rejected',
              render: (r) => (
                <span className="space-x-1 whitespace-nowrap">
                  <Badge tone="green">{formatPieces(r.passedPcs)}</Badge>
                  <Badge tone="red">{formatPieces(r.rejectedPcs + r.missingPcs)}</Badge>
                  {r.sentBackPcs > 0 && (
                    <span className="text-xs text-red-600">
                      ↩ {formatPieces(r.sentBackPcs)} rework
                    </span>
                  )}
                </span>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              render: (r) =>
                r.status === 'completed' && r.packablePcs === 0 ? (
                  <Badge tone="green">done</Badge>
                ) : r.packablePcs > 0 ? (
                  <Badge tone="violet">{formatPieces(r.packablePcs)} to pack</Badge>
                ) : (
                  <Badge tone="amber">{formatPieces(r.pendingPcs)} to check</Badge>
                ),
            },
          ]}
          rows={data?.items}
          loading={isLoading}
          emptyTitle="Nothing issued to a checker yet"
          emptyHint={canWrite ? 'Give a batch from “To check” to a checker.' : undefined}
          quickFilters={[
            { key: 'open', label: 'With checker', test: (r) => r.status === 'open' },
            { key: 'pack', label: 'Ready to pack', test: (r) => r.packablePcs > 0 },
            { key: 'rework', label: 'Had rework', test: (r) => r.sentBackPcs > 0 },
            {
              key: 'done',
              label: 'Done',
              test: (r) => r.status === 'completed' && r.packablePcs === 0,
            },
          ]}
          facets={[
            { key: 'checker', label: 'Checker', value: (r) => r.staffName },
            { key: 'contractor', label: 'Contractor', value: (r) => r.contractorName ?? undefined },
          ]}
          dateRange={{ label: 'Issue date', value: (r) => r.issueDate }}
          actions={(row) => (
            <>
              {canWrite && row.status === 'open' && (
                <Button
                  variant="ghost"
                  className="text-violet-700"
                  onClick={() => setResultFor(row)}
                >
                  Record result
                </Button>
              )}
              {canWrite && row.packablePcs > 0 && (
                <Button
                  variant="ghost"
                  className="text-emerald-700"
                  onClick={() => setPackFor(row)}
                >
                  Pack
                </Button>
              )}
              {canWrite && (
                <Button variant="ghost" onClick={() => setEditCheck(row)}>
                  Edit
                </Button>
              )}
              {isAdmin && !row.hasResults && (
                <Button variant="ghost" className="text-red-600" onClick={() => setVoidFor(row)}>
                  Void
                </Button>
              )}
            </>
          )}
        />
      )}

      {tab === 'packing' && (
        <section className="space-y-5">
          {readyToPack.length === 0 && packWork.length === 0 && bundles.length === 0 && (
            <EmptyState
              title="Nothing to pack"
              hint="Passed pieces appear here as soon as a checker records them."
            />
          )}
          {readyToPack.length > 0 && (
            <div className="rounded-2xl border border-violet-200 bg-violet-50/40 p-4">
              <h2 className="mb-2 text-sm font-bold text-gray-900">✔️ Passed, ready to pack</h2>
              <MiniTable
                rows={readyToPack}
                keyOf={(r) => r.id}
                minWidth={560}
                columns={[
                  { header: 'Checked by', className: 'font-medium', render: (r) => r.staffName },
                  {
                    header: 'Size-code',
                    render: (r) => (
                      <span>
                        {r.sizeCodeLabel} <span className="text-gray-500">{r.colorName}</span>
                      </span>
                    ),
                  },
                  { header: 'Check', className: 'font-mono text-xs', render: (r) => r.docNo },
                  {
                    header: 'To pack',
                    render: (r) => <Badge tone="violet">{formatPieces(r.packablePcs)}</Badge>,
                  },
                ]}
                actions={
                  canWrite
                    ? (r) => (
                        <Button
                          variant="ghost"
                          className="text-emerald-700"
                          onClick={() => setPackFor(r)}
                        >
                          Pack
                        </Button>
                      )
                    : undefined
                }
              />
            </div>
          )}

          {packWork.length > 0 && (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50/40 p-4">
              <h2 className="mb-2 text-sm font-bold text-gray-900">📦 Packing in progress</h2>
              <MiniTable
                rows={packWork}
                keyOf={(p) => p.id}
                minWidth={560}
                columns={[
                  { header: 'Doc', className: 'font-mono text-xs', render: (p) => p.docNo },
                  { header: 'Packer', className: 'font-medium', render: (p) => p.staffName },
                  {
                    header: 'Size-code',
                    render: (p) => (
                      <span>
                        {p.sizeCodeLabel} <span className="text-gray-500">{p.colorName}</span>
                      </span>
                    ),
                  },
                  {
                    header: 'With packer',
                    render: (p) => <Badge tone="blue">{formatPieces(p.heldPcs)}</Badge>,
                  },
                  {
                    header: 'Packed',
                    className: 'text-emerald-700',
                    render: (p) => formatPieces(p.packedPcs),
                  },
                ]}
                actions={
                  canWrite
                    ? (p) => (
                        <>
                          <Button
                            variant="ghost"
                            className="text-emerald-700"
                            onClick={() => setPackResultFor(p)}
                          >
                            Record packing
                          </Button>
                          <Button variant="ghost" onClick={() => setEditPack(p)}>
                            Edit
                          </Button>
                          {isAdmin && p.packedPcs + p.shortPcs === 0 && (
                            <Button
                              variant="ghost"
                              className="text-red-600"
                              onClick={() => setVoidPack(p)}
                            >
                              Void
                            </Button>
                          )}
                        </>
                      )
                    : undefined
                }
              />
            </div>
          )}

          {bundles.length > 0 && (
            <div className="rounded-2xl border border-sky-200 bg-sky-50/40 p-4">
              <h2 className="mb-1 text-sm font-bold text-gray-900">🎁 Bundles kept aside</h2>
              <p className="mb-2 text-xs text-gray-500">
                Checked goods the owner asked to reserve — pack them whenever needed.
              </p>
              <MiniTable
                rows={bundles}
                keyOf={(b) => b.id}
                minWidth={560}
                columns={[
                  {
                    header: 'Bundle',
                    render: (b) => (
                      <span>
                        <span className="font-medium">{b.label || b.docNo}</span>{' '}
                        <span className="font-mono text-xs text-gray-400">{b.docNo}</span>
                      </span>
                    ),
                  },
                  { header: 'With', render: (b) => b.staffName },
                  {
                    header: 'Size-code',
                    render: (b) => (
                      <span>
                        {b.sizeCodeLabel} <span className="text-gray-500">{b.colorName}</span>
                      </span>
                    ),
                  },
                  {
                    header: 'Kept aside',
                    render: (b) => <Badge tone="blue">{formatPieces(b.heldPcs)}</Badge>,
                  },
                ]}
                actions={
                  canWrite
                    ? (b) => (
                        <>
                          <Button
                            variant="ghost"
                            className="text-emerald-700"
                            onClick={() => setPackResultFor(b)}
                          >
                            Pack from bundle
                          </Button>
                          <Button variant="ghost" onClick={() => setEditPack(b)}>
                            Edit
                          </Button>
                        </>
                      )
                    : undefined
                }
              />
            </div>
          )}
        </section>
      )}

      {tab === 'packed' && (
        <DataTable
          columns={[
            {
              key: 'packedDate',
              header: 'Packed on',
              render: (r) => formatBusinessDate(r.packedDate),
              value: (r) => r.packedDate,
            },
            {
              key: 'item',
              header: 'Size-code',
              value: (r) => `${r.sizeCodeLabel} ${r.colorName}`,
              render: (r) => (
                <span className="inline-flex items-center gap-2">
                  {r.codeImagePath && (
                    <PhotoThumb src={r.codeImagePath} title={r.sizeCodeLabel} size={32} />
                  )}
                  <span>
                    <span className="font-medium">{r.sizeCodeLabel}</span>{' '}
                    <span className="text-gray-500">{r.colorName}</span>
                  </span>
                </span>
              ),
            },
            {
              key: 'packedPcs',
              header: 'Packed',
              className: 'font-semibold text-emerald-700',
              render: (r) => formatPieces(r.packedPcs),
              value: (r) => r.packedPcs,
            },
            {
              key: 'shortPcs',
              header: 'Short',
              render: (r) =>
                r.shortPcs > 0 ? (
                  <Badge tone="red">
                    {formatPieces(r.shortPcs)} {r.shortReason ? enumLabel(r.shortReason) : ''}
                  </Badge>
                ) : (
                  ''
                ),
              value: (r) => r.shortPcs,
            },
            { key: 'staffName', header: 'Packer' },
            {
              key: 'from',
              header: 'From',
              value: (r) => `${r.contractorName ?? ''} ${r.checkDocNo ?? ''} ${r.label}`,
              render: (r) => (
                <span className="text-gray-500">
                  {r.kind === 'bundle'
                    ? `Bundle “${r.label}”`
                    : (r.contractorName ?? 'Opening stock')}
                  {r.checkDocNo && (
                    <span className="ml-1 font-mono text-xs text-gray-400">{r.checkDocNo}</span>
                  )}
                </span>
              ),
            },
            { key: 'docNo', header: 'Doc', className: 'font-mono text-xs text-gray-400' },
          ]}
          rows={packed?.items}
          loading={packedLoading}
          emptyTitle="Nothing packed yet"
          emptyHint="Packed pieces become finished goods and are listed here."
          facets={[
            { key: 'packer', label: 'Packer', value: (r) => r.staffName },
            { key: 'code', label: 'Size-code', value: (r) => r.sizeCodeLabel },
            { key: 'color', label: 'Color', value: (r) => r.colorName },
          ]}
          dateRange={{ label: 'Packed on', value: (r) => r.packedDate }}
        />
      )}

      {issueFor && (
        <IssueModal
          key={`${issueFor.lotType}-${issueFor.lotId}`}
          batch={issueFor}
          onClose={() => setIssueFor(null)}
          onDone={invalidate}
        />
      )}
      <ResultModal
        key={resultFor?.id ?? 'none'}
        issue={resultFor}
        onClose={() => setResultFor(null)}
        onDone={invalidate}
      />
      {packFor && (
        <PackModal
          key={`pack-${packFor.id}`}
          issue={packFor}
          onClose={() => setPackFor(null)}
          onDone={invalidate}
        />
      )}
      <PackResultModal
        key={`pr-${packResultFor?.id ?? 'none'}`}
        issue={packResultFor}
        onClose={() => setPackResultFor(null)}
        onDone={invalidate}
      />
      {editCheck && (
        <EditCheckModal
          key={`ec-${editCheck.id}`}
          issue={editCheck}
          onClose={() => setEditCheck(null)}
          onDone={invalidate}
        />
      )}
      {editPack && (
        <EditPackModal
          key={`ep-${editPack.id}`}
          issue={editPack}
          onClose={() => setEditPack(null)}
          onDone={invalidate}
        />
      )}
      <VoidModal
        entity="check issue"
        target={
          voidFor
            ? { id: voidFor.id, label: voidFor.docNo, url: `/api/checking/${voidFor.id}/void` }
            : null
        }
        onClose={() => setVoidFor(null)}
        onDone={invalidate}
      />
      <VoidModal
        entity="packing"
        target={
          voidPack
            ? { id: voidPack.id, label: voidPack.docNo, url: `/api/packing/${voidPack.id}/void` }
            : null
        }
        onClose={() => setVoidPack(null)}
        onDone={invalidate}
      />
    </div>
  );
}

function useStaffRate() {
  const { data: staff } = useMasterOptions('staff');
  const rateOf = (id: number | null): number =>
    (staff?.find((s) => s.id === id)?.defaultRatePaisePerDozen as number | undefined) ?? 0;
  return { staff, rateOf };
}

/** Allot one received batch to a checker — contractor ↔ checker mapping is explicit. */
function IssueModal({
  batch,
  onClose,
  onDone,
}: {
  batch: PendingBatch;
  onClose: () => void;
  onDone: () => void;
}) {
  const [issueDate, setIssueDate] = useState(todayIST());
  const [staffId, setStaffId] = useState<number | null>(null);
  const [qtyPcs, setQty] = useState<number | null>(batch.qtyPcs);
  const [rate, setRate] = useState<number | null>(null);
  const [error, setError] = useState('');
  const { staff, rateOf } = useStaffRate();

  const save = useMutation({
    mutationFn: () =>
      api.post('/api/checking', {
        issueDate,
        staffId,
        lotType: batch.lotType,
        lotId: batch.lotId,
        qtyPcs,
        ratePaisePerDozen: rate ?? 0,
        notes: '',
      }),
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Save failed.'),
  });

  return (
    <Modal title="Issue batch to checker" open onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="space-y-4"
      >
        <div className="flex items-center gap-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {batch.imagePath && (
            <PhotoThumb src={batch.imagePath} title="Photo of the returned goods" size={48} />
          )}
          <span>
            <strong>{batch.contractorName ?? 'Opening stock'}</strong>
            {batch.receiptDocNo && (
              <>
                {' '}
                · receipt <span className="font-mono text-xs">{batch.receiptDocNo}</span>
              </>
            )}{' '}
            · {batch.sizeCodeLabel} {batch.colorName} ·{' '}
            <strong>{formatPieces(batch.qtyPcs)}</strong> waiting
          </span>
        </div>
        <Field label="Checker" hint="Any staff member can check or pack">
          <Select
            value={staffId ?? ''}
            onChange={(e) => {
              const next = e.target.value ? Number(e.target.value) : null;
              setStaffId(next);
              setRate(rateOf(next)); // their usual pay fills in, editable per batch
            }}
          >
            <option value="" disabled>
              — select checker —
            </option>
            {staff?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name as string}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Quantity" hint="Defaults to the whole batch — reduce to split it">
          <DzPcInput pieces={qtyPcs} onChange={setQty} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date">
            <TextInput
              type="date"
              value={issueDate}
              onChange={(e) => setIssueDate(e.target.value)}
              required
            />
          </Field>
          <Field label="Checking pay per dozen">
            <MoneyInput
              key={staffId ?? 'none'}
              paise={rate}
              onChange={setRate}
              placeholder="e.g. 3.00"
            />
          </Field>
        </div>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" disabled={save.isPending || !staffId || !qtyPcs} className="w-full">
          {save.isPending ? 'Issuing…' : 'Issue for checking'}
        </Button>
      </form>
    </Modal>
  );
}

/**
 * v2 results: passed + ONE rejected breakdown — 'missing' is a reason in the dropdown.
 * Rejected pieces go straight back to the contractor for rework (ADR-046), and by
 * default the passed pieces go straight to the checker for packing: one step, not two.
 */
function ResultModal({
  issue,
  onClose,
  onDone,
}: {
  issue: CheckIssue | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [resultDate, setResultDate] = useState(todayIST());
  const [passed, setPassed] = useState<number | null>(null);
  const [passedSeed, setPassedSeed] = useState(0);
  const [rejections, setRejections] = useState<Array<{ reason: string; qtyPcs: number | null }>>(
    [],
  );
  const [notes, setNotes] = useState('');
  const [packNow, setPackNow] = useState(true);
  const [error, setError] = useState('');

  const rejectedTotal = rejections.reduce((s, r) => s + (r.qtyPcs ?? 0), 0);
  const sentBack = rejections
    .filter((r) => r.reason !== 'missing')
    .reduce((s, r) => s + (r.qtyPcs ?? 0), 0);
  const missing = rejectedTotal - sentBack;

  const save = useMutation({
    mutationFn: () =>
      api.post(`/api/checking/${issue!.id}/results`, {
        resultDate,
        qtyPassed: passed ?? 0,
        rejections: rejections
          .filter((r) => r.qtyPcs)
          .map((r) => ({ reason: r.reason, qtyPcs: r.qtyPcs })),
        notes,
        packNow: packNow && (passed ?? 0) > 0,
      }),
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Save failed.'),
  });

  if (!issue) return null;
  const sessionTotal = (passed ?? 0) + rejectedTotal;

  return (
    <Modal title={`Checking result — ${issue.docNo}`} open onClose={onClose} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="space-y-4"
      >
        <p className="rounded-lg bg-violet-50 px-3 py-2 text-sm text-violet-900">
          {issue.staffName} holds <strong>{formatPieces(issue.pendingPcs)}</strong> of{' '}
          {issue.sizeCodeLabel} {issue.colorName}
          {issue.contractorName && <> (from {issue.contractorName})</>}. You can record results in
          parts — this session covers {formatPieces(sessionTotal)}.
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Passed">
            <div className="space-y-1.5">
              <DzPcInput key={passedSeed} pieces={passed} onChange={setPassed} />
              {rejections.length === 0 && (
                <button
                  type="button"
                  className="text-xs font-semibold text-violet-700 hover:underline"
                  onClick={() => {
                    setPassed(issue.pendingPcs);
                    setPassedSeed(passedSeed + 1);
                  }}
                >
                  All {formatPieces(issue.pendingPcs)} passed
                </button>
              )}
            </div>
          </Field>
          <Field label="Result date">
            <TextInput
              type="date"
              value={resultDate}
              onChange={(e) => setResultDate(e.target.value)}
              required
            />
          </Field>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium text-gray-700">
            Rejected pieces{' '}
            {rejectedTotal > 0 && <span>— total {formatPieces(rejectedTotal)}</span>}
          </p>
          {rejections.map((r, i) => (
            <div key={i} className="mb-2 flex flex-wrap items-end gap-2">
              <div className="w-full sm:w-44">
                <Select
                  aria-label={`Rejection reason ${i + 1}`}
                  value={r.reason}
                  onChange={(e) => {
                    const next = [...rejections];
                    next[i] = { ...r, reason: e.target.value };
                    setRejections(next);
                  }}
                >
                  {CHECK_REJECTION_REASONS.map((reason) => (
                    <option key={reason} value={reason}>
                      {enumLabel(reason)}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="min-w-0 flex-1">
                <DzPcInput
                  pieces={r.qtyPcs}
                  onChange={(pcs) => {
                    const next = [...rejections];
                    next[i] = { ...r, qtyPcs: pcs };
                    setRejections(next);
                  }}
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                className="text-red-500"
                aria-label={`Remove rejection ${i + 1}`}
                onClick={() => setRejections(rejections.filter((_, j) => j !== i))}
              >
                ✕
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              setRejections([...rejections, { reason: 'stitching_issue', qtyPcs: null }])
            }
          >
            + Add rejected pieces (reason includes “missing”)
          </Button>
          {issue.contractorName && (sentBack > 0 || missing > 0) && (
            <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
              {sentBack > 0 && (
                <>
                  ↩ {formatPieces(sentBack)} go back to <strong>{issue.contractorName}</strong> for
                  rework and come off their dues until the fixed pieces pass.{' '}
                </>
              )}
              {missing > 0 && (
                <>
                  {formatPieces(missing)} missing will be deducted from {issue.contractorName}.
                </>
              )}
            </p>
          )}
        </div>

        <Field label="Notes">
          <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        {(passed ?? 0) > 0 && (
          <label className="flex min-h-[44px] items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
            <input
              type="checkbox"
              checked={packNow}
              onChange={(e) => setPackNow(e.target.checked)}
              className="h-5 w-5 rounded border-gray-300"
            />
            <span>
              {issue.staffName} packs the passed pieces now{' '}
              <span className="text-emerald-700">(skips the separate “Pack” step)</span>
            </span>
          </label>
        )}
        <ErrorText>{error}</ErrorText>
        <Button type="submit" disabled={save.isPending || sessionTotal === 0} className="w-full">
          {save.isPending ? 'Saving…' : `Record result (${formatPieces(sessionTotal)})`}
        </Button>
      </form>
    </Modal>
  );
}

/** Correct a check issue: checker/quantity until results exist; date, rate, notes always. */
function EditCheckModal({
  issue,
  onClose,
  onDone,
}: {
  issue: CheckIssue;
  onClose: () => void;
  onDone: () => void;
}) {
  const [issueDate, setIssueDate] = useState(issue.issueDate);
  const [staffId, setStaffId] = useState<number | null>(issue.staffId);
  const [qtyPcs, setQty] = useState<number | null>(issue.qtyPcs);
  const [rate, setRate] = useState<number | null>(issue.ratePaisePerDozen);
  const [notes, setNotes] = useState(issue.notes ?? '');
  const [error, setError] = useState('');
  const { staff } = useStaffRate();
  const locked = issue.hasResults;

  const save = useMutation({
    mutationFn: () =>
      api.put(`/api/checking/${issue.id}`, {
        issueDate,
        staffId,
        qtyPcs,
        ratePaisePerDozen: rate ?? 0,
        notes,
      }),
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Save failed.'),
  });

  return (
    <Modal title={`Edit ${issue.docNo}`} open onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="space-y-4"
      >
        {locked && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Results are recorded, so the checker and quantity are fixed. The pay rate, date and
            notes can still be corrected — earnings update by themselves.
          </p>
        )}
        <Field label="Checker">
          <Select
            value={staffId ?? ''}
            disabled={locked}
            onChange={(e) => setStaffId(Number(e.target.value))}
          >
            {staff?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name as string}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Quantity">
          <DzPcInput pieces={qtyPcs} onChange={setQty} disabled={locked} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date">
            <TextInput
              type="date"
              value={issueDate}
              onChange={(e) => setIssueDate(e.target.value)}
              required
            />
          </Field>
          <Field label="Pay per dozen">
            <MoneyInput paise={rate} onChange={setRate} />
          </Field>
        </div>
        <Field label="Notes">
          <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" disabled={save.isPending || !qtyPcs} className="w-full">
          {save.isPending ? 'Saving…' : 'Save changes'}
        </Button>
      </form>
    </Modal>
  );
}

/**
 * Allot this check issue's passed pieces to packing — default packer is the checker —
 * or keep them aside as a labeled bundle for later.
 */
function PackModal({
  issue,
  onClose,
  onDone,
}: {
  issue: CheckIssue;
  onClose: () => void;
  onDone: () => void;
}) {
  const [issueDate, setIssueDate] = useState(todayIST());
  const [staffId, setStaffId] = useState<number | null>(issue.staffId);
  const [qtyPcs, setQty] = useState<number | null>(issue.packablePcs);
  const [kind, setKind] = useState<'pack' | 'bundle'>('pack');
  const [bundleLabel, setBundleLabel] = useState('');
  const [rateOverride, setRateOverride] = useState<number | null>(null);
  const [rateTouched, setRateTouched] = useState(false);
  const { staff, rateOf } = useStaffRate();
  const [error, setError] = useState('');

  // the packer's usual rate fills in (the checker is pre-selected); editable per job
  const rate = rateTouched ? rateOverride : rateOf(staffId);

  const save = useMutation({
    mutationFn: () =>
      api.post(`/api/checking/${issue.id}/pack`, {
        issueDate,
        staffId,
        qtyPcs,
        kind,
        label: bundleLabel,
        ratePaisePerDozen: rate ?? 0,
        notes: '',
      }),
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Save failed.'),
  });

  return (
    <Modal title={`Pack — ${issue.sizeCodeLabel} ${issue.colorName}`} open onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (kind === 'bundle' && !bundleLabel.trim()) {
            setError('Give the bundle a name so it can be found later.');
            return;
          }
          save.mutate();
        }}
        className="space-y-4"
      >
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          <strong>{formatPieces(issue.packablePcs)}</strong> passed by {issue.staffName} are ready.
          9 times out of 10 the checker packs their own goods — change the person only if someone
          else will pack.
        </p>
        <Field label="Packer">
          <Select
            value={staffId ?? ''}
            onChange={(e) => {
              setStaffId(e.target.value ? Number(e.target.value) : null);
              setRateTouched(false); // a new packer brings their own usual rate
            }}
          >
            {staff?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name as string}
                {s.id === issue.staffId ? ' (checked these goods)' : ''}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Quantity">
          <DzPcInput pieces={qtyPcs} onChange={setQty} />
        </Field>
        <Field label="What happens to these pieces?">
          <Select value={kind} onChange={(e) => setKind(e.target.value as 'pack' | 'bundle')}>
            <option value="pack">Pack now (towards finished goods)</option>
            <option value="bundle">Keep aside as a bundle (pack later)</option>
          </Select>
        </Field>
        {kind === 'bundle' && (
          <Field
            label="Bundle name"
            hint="e.g. “Festival order reserve” — how you’ll find it later"
          >
            <TextInput value={bundleLabel} onChange={(e) => setBundleLabel(e.target.value)} />
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date">
            <TextInput
              type="date"
              value={issueDate}
              onChange={(e) => setIssueDate(e.target.value)}
              required
            />
          </Field>
          <Field label="Packing pay per dozen">
            <MoneyInput
              key={`${staffId ?? 'none'}-${staff ? 'loaded' : 'loading'}`}
              paise={rate}
              onChange={(p) => {
                setRateOverride(p);
                setRateTouched(true);
              }}
              placeholder="e.g. 2.00"
            />
          </Field>
        </div>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" disabled={save.isPending || !staffId || !qtyPcs} className="w-full">
          {save.isPending
            ? 'Saving…'
            : kind === 'bundle'
              ? 'Keep bundle aside'
              : 'Allot for packing'}
        </Button>
      </form>
    </Modal>
  );
}

/** Correct packing work / a bundle: packer + quantity until packed; the rest always. */
function EditPackModal({
  issue,
  onClose,
  onDone,
}: {
  issue: PackIssue;
  onClose: () => void;
  onDone: () => void;
}) {
  const [issueDate, setIssueDate] = useState(issue.issueDate);
  const [staffId, setStaffId] = useState<number | null>(issue.staffId);
  const [qtyPcs, setQty] = useState<number | null>(issue.qtyPcs);
  const [label, setLabel] = useState(issue.label ?? '');
  const [rate, setRate] = useState<number | null>(issue.ratePaisePerDozen);
  const [notes, setNotes] = useState(issue.notes ?? '');
  const [error, setError] = useState('');
  const { staff } = useStaffRate();
  const locked = issue.packedPcs + issue.shortPcs > 0 || issue.heldPcs < issue.qtyPcs;

  const save = useMutation({
    mutationFn: () =>
      api.put(`/api/packing/${issue.id}`, {
        issueDate,
        staffId,
        qtyPcs,
        label,
        ratePaisePerDozen: rate ?? 0,
        notes,
      }),
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Save failed.'),
  });

  return (
    <Modal
      title={`Edit ${issue.kind === 'bundle' ? 'bundle' : 'packing'} ${issue.docNo}`}
      open
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="space-y-4"
      >
        {locked && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Some of this is already packed, so the packer and quantity are fixed. The rate, date
            {issue.kind === 'bundle' ? ', name' : ''} and notes can still be corrected.
          </p>
        )}
        {issue.kind === 'bundle' && (
          <Field label="Bundle name">
            <TextInput value={label} onChange={(e) => setLabel(e.target.value)} required />
          </Field>
        )}
        <Field label={issue.kind === 'bundle' ? 'Held by' : 'Packer'}>
          <Select
            value={staffId ?? ''}
            disabled={locked}
            onChange={(e) => setStaffId(Number(e.target.value))}
          >
            {staff?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name as string}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Quantity">
          <DzPcInput pieces={qtyPcs} onChange={setQty} disabled={locked} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date">
            <TextInput
              type="date"
              value={issueDate}
              onChange={(e) => setIssueDate(e.target.value)}
              required
            />
          </Field>
          <Field label="Pay per dozen">
            <MoneyInput paise={rate} onChange={setRate} />
          </Field>
        </div>
        <Field label="Notes">
          <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" disabled={save.isPending || !qtyPcs} className="w-full">
          {save.isPending ? 'Saving…' : 'Save changes'}
        </Button>
      </form>
    </Modal>
  );
}

/** Record packed / short pieces for a pack issue or a bundle. */
function PackResultModal({
  issue,
  onClose,
  onDone,
}: {
  issue: PackIssue | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [resultDate, setResultDate] = useState(todayIST());
  const [packed, setPacked] = useState<number | null>(null);
  const [packedSeed, setPackedSeed] = useState(0);
  const [short, setShort] = useState<number | null>(null);
  const [shortReason, setShortReason] = useState('');
  const [error, setError] = useState('');

  const save = useMutation({
    mutationFn: () =>
      api.post(`/api/packing/${issue!.id}/results`, {
        resultDate,
        qtyPacked: packed ?? 0,
        qtyShort: short ?? 0,
        shortReason: shortReason || null,
        notes: '',
      }),
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Save failed.'),
  });

  if (!issue) return null;

  return (
    <Modal
      title={`${issue.kind === 'bundle' ? 'Pack from bundle' : 'Packing result'} — ${issue.label || issue.docNo}`}
      open
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="space-y-4"
      >
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          {issue.staffName} holds <strong>{formatPieces(issue.heldPcs)}</strong> of{' '}
          {issue.sizeCodeLabel} {issue.colorName}. Packed pieces become Finished Goods
          {issue.ratePaisePerDozen > 0 && <> (pay {formatPaise(issue.ratePaisePerDozen)}/dz)</>}.
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Packed">
            <div className="space-y-1.5">
              <DzPcInput key={packedSeed} pieces={packed} onChange={setPacked} />
              <button
                type="button"
                className="text-xs font-semibold text-emerald-700 hover:underline"
                onClick={() => {
                  setPacked(issue.heldPcs);
                  setPackedSeed(packedSeed + 1);
                }}
              >
                All {formatPieces(issue.heldPcs)} packed
              </button>
            </div>
          </Field>
          <Field label="Short (if any)">
            <DzPcInput pieces={short} onChange={setShort} />
          </Field>
        </div>
        {(short ?? 0) > 0 && (
          <Field label="Reason for shortage">
            <Select value={shortReason} onChange={(e) => setShortReason(e.target.value)}>
              <option value="">— reason —</option>
              {PACK_SHORT_REASONS.map((r) => (
                <option key={r} value={r}>
                  {enumLabel(r)}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Date">
          <TextInput
            type="date"
            value={resultDate}
            onChange={(e) => setResultDate(e.target.value)}
            required
          />
        </Field>
        <ErrorText>{error}</ErrorText>
        <Button
          type="submit"
          disabled={save.isPending || (packed ?? 0) + (short ?? 0) === 0}
          className="w-full"
        >
          {save.isPending ? 'Saving…' : 'Record packing'}
        </Button>
      </form>
    </Modal>
  );
}
