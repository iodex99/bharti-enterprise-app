import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CHECK_REJECTION_REASONS,
  PACK_SHORT_REASONS,
  formatBusinessDate,
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
  ErrorText,
  Field,
  MiniTable,
  Modal,
  Select,
  TextInput,
  ThumbLink,
} from '../../components/ui';
import { DzPcInput, MoneyInput } from '../../components/inputs';
import { useMasterOptions } from '../../api/masters';
import { VoidModal } from '../purchases/PurchasesPage';

/**
 * Checking & Packing (ADR-034/035). One page for the whole verification flow:
 *   pending batches → issue to a checker → record pass/rejected (missing is a reason)
 *   → allot the passed pieces to packing (usually the same person) or keep a bundle
 *   → record packing → finished goods.
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
  passedPcs: number;
  rejectedPcs: number;
  missingPcs: number;
  pendingPcs: number;
  packablePcs: number;
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
  staffName: string;
  kind: 'pack' | 'bundle';
  label: string;
  sizeCodeLabel: string;
  colorName: string;
  qtyPcs: number;
  packedPcs: number;
  shortPcs: number;
  heldPcs: number;
  voidedAt: string | null;
};

export default function CheckingPage() {
  const { user } = useAuth();
  const canWrite = user?.role === 'admin' || user?.role === 'operator';
  const isAdmin = user?.role === 'admin';
  const queryClient = useQueryClient();
  const [issueFor, setIssueFor] = useState<PendingBatch | null>(null);
  const [resultFor, setResultFor] = useState<CheckIssue | null>(null);
  const [packFor, setPackFor] = useState<CheckIssue | null>(null);
  const [packResultFor, setPackResultFor] = useState<PackIssue | null>(null);
  const [voidFor, setVoidFor] = useState<CheckIssue | null>(null);

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

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['checking'] });
    void queryClient.invalidateQueries({ queryKey: ['packing'] });
    void queryClient.invalidateQueries({ queryKey: ['stock'] });
    void queryClient.invalidateQueries({ queryKey: ['jobs'] });
  };

  const bundles = packing?.items.filter((p) => p.kind === 'bundle' && p.heldPcs > 0) ?? [];
  const packWork = packing?.items.filter((p) => p.kind === 'pack' && p.status === 'open') ?? [];

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4">
        <h1 className="text-xl font-bold text-gray-900">Checking &amp; Packing</h1>
        <p className="text-sm text-gray-500">
          Returned goods count only after checking — and the checker usually packs them too
        </p>
      </div>

      {/* pending for checking: the contractor's claimed returns, batch by batch */}
      <section className="mb-5 rounded-2xl border border-amber-200 bg-amber-50/40 p-4">
        <h2 className="mb-1 text-sm font-bold text-gray-900">
          📥 Pending for checking{' '}
          <span className="font-normal text-gray-400">({pending?.items.length ?? 0} batches)</span>
        </h2>
        <p className="mb-3 text-xs text-gray-500">
          Received from contractors but not yet verified — allot each batch to a checker.
        </p>
        {pending && pending.items.length === 0 && (
          <p className="text-sm text-gray-400">
            Nothing waiting — every received batch is with a checker.
          </p>
        )}
        {pending && pending.items.length > 0 && (
          <MiniTable
            rows={pending.items}
            keyOf={(b) => `${b.lotType}-${b.lotId}`}
            columns={[
              {
                header: 'Received',
                className: 'text-gray-500',
                render: (b) => (b.receiptDate ? formatBusinessDate(b.receiptDate) : '—'),
              },
              {
                header: 'From',
                className: 'font-medium',
                render: (b) => b.contractorName ?? 'Opening stock',
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
              {
                header: 'Photo',
                render: (b) =>
                  b.imagePath ? (
                    <ThumbLink
                      href={b.imagePath}
                      label="view"
                      title="Photo of the returned goods"
                    />
                  ) : (
                    <span className="text-gray-300">—</span>
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
                <span>
                  {r.contractorName}{' '}
                  {r.receiptDocNo && (
                    <span className="font-mono text-xs text-gray-400">({r.receiptDocNo})</span>
                  )}{' '}
                  {r.receiptImagePath && (
                    <ThumbLink href={r.receiptImagePath} title="Photo of the returned goods" />
                  )}
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
                {r.codeImagePath && <ThumbLink href={r.codeImagePath} title="Product photo" />}
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
        emptyHint={canWrite ? 'Allot a pending batch above to a checker.' : undefined}
        facets={[
          { key: 'checker', label: 'Checker', value: (r) => r.staffName },
          { key: 'contractor', label: 'Contractor', value: (r) => r.contractorName ?? undefined },
          { key: 'status', label: 'Status', value: (r) => r.status },
        ]}
        dateRange={{ label: 'Issue date', value: (r) => r.issueDate }}
        actions={(row) => (
          <>
            {canWrite && row.status === 'open' && (
              <Button variant="ghost" className="text-violet-700" onClick={() => setResultFor(row)}>
                Record result
              </Button>
            )}
            {canWrite && row.packablePcs > 0 && (
              <Button variant="ghost" className="text-emerald-700" onClick={() => setPackFor(row)}>
                Pack
              </Button>
            )}
            {isAdmin && row.passedPcs + row.rejectedPcs + row.missingPcs === 0 && (
              <Button variant="ghost" className="text-red-600" onClick={() => setVoidFor(row)}>
                Void
              </Button>
            )}
          </>
        )}
      />

      {/* packing in progress — allotted from the checking rows above */}
      {(packWork.length > 0 || bundles.length > 0) && (
        <section className="mt-6 space-y-4">
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
                        <Button
                          variant="ghost"
                          className="text-emerald-700"
                          onClick={() => setPackResultFor(p)}
                        >
                          Record packing
                        </Button>
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
                        <Button
                          variant="ghost"
                          className="text-emerald-700"
                          onClick={() => setPackResultFor(b)}
                        >
                          Pack from bundle
                        </Button>
                      )
                    : undefined
                }
              />
            </div>
          )}
        </section>
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
    </div>
  );
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
  const { data: staff } = useMasterOptions('staff');

  const staffRate = (id: number | null): number =>
    (staff?.find((s) => s.id === id)?.defaultRatePaisePerDozen as number | undefined) ?? 0;

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
        <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <strong>{batch.contractorName ?? 'Opening stock'}</strong>
          {batch.receiptDocNo && (
            <>
              {' '}
              · receipt <span className="font-mono text-xs">{batch.receiptDocNo}</span>
            </>
          )}{' '}
          · {batch.sizeCodeLabel} {batch.colorName} · <strong>{formatPieces(batch.qtyPcs)}</strong>{' '}
          waiting
          {batch.imagePath && (
            <>
              {' '}
              <ThumbLink href={batch.imagePath} label="photo" title="Photo of the returned goods" />
            </>
          )}
        </div>
        <Field label="Date">
          <TextInput
            type="date"
            value={issueDate}
            onChange={(e) => setIssueDate(e.target.value)}
            required
          />
        </Field>
        <Field label="Checker" hint="Any staff member can check or pack">
          <Select
            value={staffId ?? ''}
            onChange={(e) => {
              const next = e.target.value ? Number(e.target.value) : null;
              setStaffId(next);
              setRate(staffRate(next)); // their usual pay fills in, editable per batch
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
        <Field
          label="Checking pay per dozen"
          hint="Filled from the checker's usual rate — change it for this batch if needed"
        >
          <MoneyInput
            key={staffId ?? 'none'}
            paise={rate}
            onChange={setRate}
            placeholder="e.g. 3.00"
          />
        </Field>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" disabled={save.isPending || !staffId || !qtyPcs} className="w-full">
          {save.isPending ? 'Issuing…' : 'Issue for checking'}
        </Button>
      </form>
    </Modal>
  );
}

/** v2 results: passed + ONE rejected breakdown — 'missing' is a reason in the dropdown. */
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
  const [rejections, setRejections] = useState<Array<{ reason: string; qtyPcs: number | null }>>(
    [],
  );
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');

  const rejectedTotal = rejections.reduce((s, r) => s + (r.qtyPcs ?? 0), 0);

  const save = useMutation({
    mutationFn: () =>
      api.post(`/api/checking/${issue!.id}/results`, {
        resultDate,
        qtyPassed: passed ?? 0,
        rejections: rejections
          .filter((r) => r.qtyPcs)
          .map((r) => ({ reason: r.reason, qtyPcs: r.qtyPcs })),
        notes,
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
          <Field label="Result date">
            <TextInput
              type="date"
              value={resultDate}
              onChange={(e) => setResultDate(e.target.value)}
              required
            />
          </Field>
          <Field label="Passed">
            <DzPcInput pieces={passed} onChange={setPassed} />
          </Field>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium text-gray-700">
            Rejected pieces{' '}
            {rejectedTotal > 0 && <span>— total {formatPieces(rejectedTotal)}</span>}
          </p>
          {rejections.map((r, i) => (
            <div key={i} className="mb-2 flex items-end gap-2">
              <div className="w-44">
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
              <div className="flex-1">
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
        </div>

        <Field label="Notes">
          <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" disabled={save.isPending || sessionTotal === 0} className="w-full">
          {save.isPending ? 'Saving…' : `Record result (${formatPieces(sessionTotal)})`}
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
  const { data: staff } = useMasterOptions('staff');
  const [error, setError] = useState('');

  const staffRate = (id: number | null): number =>
    (staff?.find((s) => s.id === id)?.defaultRatePaisePerDozen as number | undefined) ?? 0;
  // the packer's usual rate fills in (the checker is pre-selected); editable per job
  const rate = rateTouched ? rateOverride : staffRate(staffId);

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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Date">
            <TextInput
              type="date"
              value={issueDate}
              onChange={(e) => setIssueDate(e.target.value)}
              required
            />
          </Field>
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
        </div>
        <Field label="Quantity">
          <DzPcInput pieces={qtyPcs} onChange={setQty} />
        </Field>
        <Field
          label="Packing pay per dozen"
          hint="Filled from the packer's usual rate — change it for this work if needed"
        >
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
          {issue.sizeCodeLabel} {issue.colorName}. Packed pieces become Finished Goods.
        </p>
        <Field label="Date">
          <TextInput
            type="date"
            value={resultDate}
            onChange={(e) => setResultDate(e.target.value)}
            required
          />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Packed">
            <DzPcInput pieces={packed} onChange={setPacked} />
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
