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
import { MasterSelect } from '../../components/MasterSelect';
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
};

export default function CheckingPage() {
  const { user } = useAuth();
  const canWrite = user?.role === 'admin' || user?.role === 'operator';
  const isAdmin = user?.role === 'admin';
  const queryClient = useQueryClient();
  const [issueOpen, setIssueOpen] = useState(false);
  const [resultFor, setResultFor] = useState<CheckIssue | null>(null);
  const [voidFor, setVoidFor] = useState<CheckIssue | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['checking'],
    queryFn: () => api.get<{ items: CheckIssue[] }>('/api/checking'),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['checking'] });
    void queryClient.invalidateQueries({ queryKey: ['stock'] });
  };

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Checking</h1>
          <p className="text-sm text-gray-500">
            Quality inspection of stitched goods (Module 7)
          </p>
        </div>
        {canWrite && <Button onClick={() => setIssueOpen(true)}>+ Issue to checker</Button>}
      </div>

      <DataTable
        columns={[
          { key: 'docNo', header: 'Doc', className: 'font-mono text-xs font-medium' },
          { key: 'issueDate', header: 'Date', render: (r) => formatBusinessDate(r.issueDate) },
          { key: 'staffName', header: 'Checker' },
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
          { key: 'qtyPcs', header: 'Issued', render: (r) => formatPieces(r.qtyPcs) },
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
        emptyTitle="Nothing issued for checking yet"
        emptyHint={canWrite ? 'Receive stitched goods from a contractor first, then issue them here.' : undefined}
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

      <IssueModal key={String(issueOpen)} open={issueOpen} onClose={() => setIssueOpen(false)} onDone={invalidate} />
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

function IssueModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [issueDate, setIssueDate] = useState(todayIST());
  const [staffId, setStaffId] = useState<number | null>(null);
  const [modelId, setModelId] = useState<number | null>(null);
  const [colorId, setColorId] = useState<number | null>(null);
  const [sizeId, setSizeId] = useState<number | null>(null);
  const [qtyPcs, setQty] = useState<number | null>(null);
  const [error, setError] = useState('');
  const { data: staff } = useMasterOptions('staff');
  const checkers = staff?.filter((s) => s.role === 'checker' || s.role === 'both');

  const save = useMutation({
    mutationFn: () =>
      api.post('/api/checking', { issueDate, staffId, modelId, colorId, sizeId, qtyPcs, notes: '' }),
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Save failed.'),
  });

  return (
    <Modal title="Issue goods for checking" open={open} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="space-y-4"
      >
        <Field label="Date">
          <TextInput type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} required />
        </Field>
        <Field label="Checker">
          <Select value={staffId ?? ''} onChange={(e) => setStaffId(e.target.value ? Number(e.target.value) : null)}>
            <option value="" disabled>
              — select checker —
            </option>
            {checkers?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name as string} {s.role === 'both' ? '(checker+packer)' : ''}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Model">
          <MasterSelect master="models" value={modelId} onChange={setModelId} />
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
        <ErrorText>{error}</ErrorText>
        <Button type="submit" disabled={save.isPending} className="w-full">
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
          {issue.modelCode} {issue.colorName} {issue.sizeCode}. You can record results in
          parts — this session covers {formatPieces(sessionTotal)}.
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
