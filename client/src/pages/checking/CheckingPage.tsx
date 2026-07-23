import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CHECK_REJECTION_REASONS,
  formatBusinessDate,
  formatPieces,
  label as enumLabel,
  todayIST,
} from '@shared';
import { api, ApiError } from '../../api/client';
import { useAuth } from '../../lib/auth';
import { DataTable } from '../../components/DataTable';
import { Badge, Button, ErrorText, Field, Modal, Select, TextInput } from '../../components/ui';
import { DzPcInput } from '../../components/inputs';
import { useMasterOptions } from '../../api/masters';
import { VoidModal } from '../purchases/PurchasesPage';

type CheckIssue = {
  id: number;
  docNo: string;
  issueDate: string;
  status: 'open' | 'completed';
  staffName: string;
  modelCode: string;
  colorName: string;
  sizeCode: string;
  qtyPcs: number;
  passedPcs: number;
  rejectedPcs: number;
  missingPcs: number;
  pendingPcs: number;
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
  modelCode: string;
  colorName: string;
  sizeCode: string;
  receiptDocNo: string | null;
  receiptDate: string | null;
  imagePath: string | null;
  jobDocNo: string | null;
  contractorName: string | null;
  openingDocNo: string | null;
};

export default function CheckingPage() {
  const { user } = useAuth();
  const canWrite = user?.role === 'admin' || user?.role === 'operator';
  const isAdmin = user?.role === 'admin';
  const queryClient = useQueryClient();
  const [issueFor, setIssueFor] = useState<PendingBatch | null>(null);
  const [resultFor, setResultFor] = useState<CheckIssue | null>(null);
  const [voidFor, setVoidFor] = useState<CheckIssue | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['checking'],
    queryFn: () => api.get<{ items: CheckIssue[] }>('/api/checking'),
  });
  const { data: pending } = useQuery({
    queryKey: ['checking', 'pending'],
    queryFn: () => api.get<{ items: PendingBatch[] }>('/api/checking/pending'),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['checking'] });
    void queryClient.invalidateQueries({ queryKey: ['stock'] });
    void queryClient.invalidateQueries({ queryKey: ['jobs'] });
  };

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4">
        <h1 className="text-xl font-bold text-gray-900">Checking</h1>
        <p className="text-sm text-gray-500">
          Goods a contractor returns count only after a checker verifies them (Module 7)
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
          <p className="text-sm text-gray-400">Nothing waiting — every received batch is with a checker.</p>
        )}
        {pending && pending.items.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-400">
                  <th className="px-3 py-2">Received</th>
                  <th className="px-3 py-2">From</th>
                  <th className="px-3 py-2">Receipt</th>
                  <th className="px-3 py-2">Item</th>
                  <th className="px-3 py-2">Waiting</th>
                  <th className="px-3 py-2">Photo</th>
                  {canWrite && <th className="px-3 py-2 text-right">Action</th>}
                </tr>
              </thead>
              <tbody>
                {pending.items.map((b) => (
                  <tr key={`${b.lotType}-${b.lotId}`} className="border-b border-gray-100 last:border-0">
                    <td className="px-3 py-2 text-gray-500">
                      {b.receiptDate ? formatBusinessDate(b.receiptDate) : '—'}
                    </td>
                    <td className="px-3 py-2 font-medium">{b.contractorName ?? 'Opening stock'}</td>
                    <td className="px-3 py-2 font-mono text-xs text-gray-500">
                      {b.receiptDocNo ?? b.openingDocNo ?? '—'}
                    </td>
                    <td className="px-3 py-2">
                      {b.modelCode} <span className="text-gray-500">{b.colorName} · {b.sizeCode}</span>
                    </td>
                    <td className="px-3 py-2">
                      <span className="font-semibold text-red-700">{formatPieces(b.qtyPcs)}</span>
                    </td>
                    <td className="px-3 py-2">
                      {b.imagePath ? (
                        <a href={b.imagePath} target="_blank" rel="noreferrer" className="text-violet-600 hover:underline">
                          📷 view
                        </a>
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </td>
                    {canWrite && (
                      <td className="px-3 py-2 text-right">
                        <Button variant="ghost" className="text-violet-700" onClick={() => setIssueFor(b)}>
                          Issue to checker
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
                  {r.receiptDocNo && <span className="font-mono text-xs text-gray-400">({r.receiptDocNo})</span>}{' '}
                  {r.receiptImagePath && (
                    <a href={r.receiptImagePath} target="_blank" rel="noreferrer" title="Receipt photo">
                      📷
                    </a>
                  )}
                </span>
              ) : (
                <span className="text-gray-300">—</span>
              ),
          },
          {
            key: 'item',
            header: 'Item',
            value: (r) => `${r.modelCode} ${r.colorName} ${r.sizeCode}`,
            render: (r) => (
              <span>
                <span className="font-medium">{r.modelCode}</span>{' '}
                <span className="text-gray-500">
                  {r.colorName} · {r.sizeCode}
                </span>
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
            header: 'Passed / Rejected / Missing',
            render: (r) => (
              <span className="space-x-1 whitespace-nowrap">
                <Badge tone="green">{formatPieces(r.passedPcs)}</Badge>
                <Badge tone="red">{formatPieces(r.rejectedPcs)}</Badge>
                <Badge tone="gray">{formatPieces(r.missingPcs)}</Badge>
              </span>
            ),
          },
          {
            key: 'status',
            header: 'Status',
            render: (r) =>
              r.status === 'completed' ? (
                <Badge tone="green">completed</Badge>
              ) : (
                <Badge tone="amber">{formatPieces(r.pendingPcs)} pending</Badge>
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
            {isAdmin && row.passedPcs + row.rejectedPcs + row.missingPcs === 0 && (
              <Button variant="ghost" className="text-red-600" onClick={() => setVoidFor(row)}>
                Void
              </Button>
            )}
          </>
        )}
      />

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
      <VoidModal
        entity="check issue"
        target={voidFor ? { id: voidFor.id, label: voidFor.docNo, url: `/api/checking/${voidFor.id}/void` } : null}
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
  const [error, setError] = useState('');
  const { data: staff } = useMasterOptions('staff');

  const save = useMutation({
    mutationFn: () =>
      api.post('/api/checking', {
        issueDate,
        staffId,
        lotType: batch.lotType,
        lotId: batch.lotId,
        qtyPcs,
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
          {batch.receiptDocNo && <> · receipt <span className="font-mono text-xs">{batch.receiptDocNo}</span></>} ·{' '}
          {batch.modelCode} {batch.colorName} {batch.sizeCode} ·{' '}
          <strong>{formatPieces(batch.qtyPcs)}</strong> waiting
          {batch.imagePath && (
            <>
              {' '}
              <a href={batch.imagePath} target="_blank" rel="noreferrer" className="text-violet-700 underline">
                📷 photo
              </a>
            </>
          )}
        </div>
        <Field label="Date">
          <TextInput type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} required />
        </Field>
        <Field label="Checker" hint="Any staff member can check or pack">
          <Select value={staffId ?? ''} onChange={(e) => setStaffId(e.target.value ? Number(e.target.value) : null)}>
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
        <ErrorText>{error}</ErrorText>
        <Button type="submit" disabled={save.isPending || !staffId || !qtyPcs} className="w-full">
          {save.isPending ? 'Issuing…' : 'Issue for checking'}
        </Button>
      </form>
    </Modal>
  );
}

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
  const [missing, setMissing] = useState<number | null>(null);
  const [rejections, setRejections] = useState<Array<{ reason: string; qtyPcs: number | null }>>([]);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');

  const rejectedTotal = rejections.reduce((s, r) => s + (r.qtyPcs ?? 0), 0);

  const save = useMutation({
    mutationFn: () =>
      api.post(`/api/checking/${issue!.id}/results`, {
        resultDate,
        qtyPassed: passed ?? 0,
        qtyRejected: rejectedTotal,
        qtyMissing: missing ?? 0,
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
  const sessionTotal = (passed ?? 0) + rejectedTotal + (missing ?? 0);

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
          {issue.modelCode} {issue.colorName} {issue.sizeCode}
          {issue.contractorName && <> (from {issue.contractorName})</>}. You can record
          results in parts — this session covers {formatPieces(sessionTotal)}.
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Result date">
            <TextInput type="date" value={resultDate} onChange={(e) => setResultDate(e.target.value)} required />
          </Field>
          <Field label="Passed">
            <DzPcInput pieces={passed} onChange={setPassed} />
          </Field>
          <Field label="Missing">
            <DzPcInput pieces={missing} onChange={setMissing} />
          </Field>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium text-gray-700">
            Rejected pieces {rejectedTotal > 0 && <span>— total {formatPieces(rejectedTotal)}</span>}
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
            onClick={() => setRejections([...rejections, { reason: 'stitching_issue', qtyPcs: null }])}
          >
            + Add rejection reason
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
