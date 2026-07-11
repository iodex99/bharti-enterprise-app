import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatBusinessDate,
  formatPaise,
  formatPieces,
  JOB_DISCREPANCY_REASONS,
  label as enumLabel,
  todayIST,
} from '@shared';
import { api, ApiError } from '../../api/client';
import { useAuth } from '../../lib/auth';
import { DataTable } from '../../components/DataTable';
import { Badge, Button, ErrorText, Field, Modal, Select, TextInput } from '../../components/ui';
import { DzPcInput, MoneyInput } from '../../components/inputs';
import { MasterSelect } from '../../components/MasterSelect';
import { useMasterOptions } from '../../api/masters';
import { VoidModal } from '../purchases/PurchasesPage';

export type JobLine = {
  id: number;
  sizeId: number;
  sizeCode: string;
  qtyIssuedPcs: number;
  ratePaisePerDozen: number;
  receivedPcs: number;
  returnedPcs: number;
  pendingPcs: number;
  excessPcs: number;
};

export type JobCard = {
  id: number;
  docNo: string;
  issueDate: string;
  status: 'open' | 'partially_received' | 'completed' | 'closed_with_discrepancy';
  contractorId: number;
  contractorName: string;
  modelCode: string;
  colorName: string;
  notes: string;
  closeNote: string;
  voidedAt: string | null;
  lines: JobLine[];
  issuedPcs: number;
  receivedPcs: number;
  returnedPcs: number;
  pendingPcs: number;
  jobCostPaise: number;
};

const STATUS_TONE = {
  open: 'amber',
  partially_received: 'blue',
  completed: 'green',
  closed_with_discrepancy: 'red',
} as const;

export function JobStatusBadge({ status }: { status: JobCard['status'] }) {
  return <Badge tone={STATUS_TONE[status]}>{enumLabel(status)}</Badge>;
}

export default function JobsPage() {
  const { user } = useAuth();
  const canWrite = user?.role === 'admin' || user?.role === 'operator';
  const isAdmin = user?.role === 'admin';
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [detailFor, setDetailFor] = useState<number | null>(null);
  const [voidFor, setVoidFor] = useState<JobCard | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['jobs'],
    queryFn: () => api.get<{ items: JobCard[] }>('/api/jobs'),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['jobs'] });
    void queryClient.invalidateQueries({ queryKey: ['stock'] });
    void queryClient.invalidateQueries({ queryKey: ['contractors'] });
  };

  const detail = data?.items.find((j) => j.id === detailFor) ?? null;

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Job Work</h1>
          <p className="text-sm text-gray-500">
            Cut pieces issued to contractors for stitching (Modules 5–6)
          </p>
        </div>
        {canWrite && <Button onClick={() => setCreateOpen(true)}>+ New job card</Button>}
      </div>

      <DataTable
        columns={[
          { key: 'docNo', header: 'Job', className: 'font-mono text-xs font-medium' },
          { key: 'issueDate', header: 'Issued', render: (r) => formatBusinessDate(r.issueDate) },
          { key: 'contractorName', header: 'Contractor' },
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
          {
            key: 'sizes',
            header: 'Sizes',
            value: (r) => r.lines.map((l) => l.sizeCode).join(' '),
            render: (r) => (
              <span className="text-gray-500">{r.lines.map((l) => l.sizeCode).join(', ')}</span>
            ),
          },
          { key: 'issuedPcs', header: 'Issued', render: (r) => formatPieces(r.issuedPcs) },
          {
            key: 'pendingPcs',
            header: 'Pending',
            render: (r) =>
              r.pendingPcs === 0 ? (
                <span className="text-gray-300">—</span>
              ) : (
                <span className="font-semibold text-amber-700">{formatPieces(r.pendingPcs)}</span>
              ),
          },
          { key: 'status', header: 'Status', render: (r) => <JobStatusBadge status={r.status} /> },
        ]}
        rows={data?.items}
        loading={isLoading}
        emptyTitle="No job cards yet"
        emptyHint={canWrite ? 'Issue cut pieces to a contractor with “+ New job card”.' : undefined}
        facets={[
          { key: 'status', label: 'Status', value: (r) => enumLabel(r.status) },
          { key: 'contractor', label: 'Contractor', value: (r) => r.contractorName },
          { key: 'model', label: 'Model', value: (r) => r.modelCode },
        ]}
        dateRange={{ label: 'Issue date', value: (r) => r.issueDate }}
        actions={(row) => (
          <>
            <Button variant="ghost" onClick={() => setDetailFor(row.id)}>
              Open
            </Button>
            {isAdmin && !row.voidedAt && row.receivedPcs === 0 && row.returnedPcs === 0 && (
              <Button variant="ghost" className="text-red-600" onClick={() => setVoidFor(row)}>
                Void
              </Button>
            )}
          </>
        )}
      />

      <NewJobModal key={String(createOpen)} open={createOpen} onClose={() => setCreateOpen(false)} onDone={invalidate} />
      {detail && (
        <JobDetailModal
          job={detail}
          onClose={() => setDetailFor(null)}
          onChanged={invalidate}
          canWrite={canWrite}
          isAdmin={isAdmin}
        />
      )}
      <VoidModal
        entity="job card"
        target={voidFor ? { id: voidFor.id, label: voidFor.docNo, url: `/api/jobs/${voidFor.id}/void` } : null}
        onClose={() => setVoidFor(null)}
        onDone={invalidate}
      />
    </div>
  );
}

function NewJobModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [issueDate, setIssueDate] = useState(todayIST());
  const [contractorId, setContractorId] = useState<number | null>(null);
  const [modelId, setModelId] = useState<number | null>(null);
  const [colorId, setColorId] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Array<{ sizeId: number | null; qtyPcs: number | null; rate: number | null }>>([
    { sizeId: null, qtyPcs: null, rate: null },
  ]);
  const [error, setError] = useState('');
  const { data: sizes } = useMasterOptions('sizes');
  const { data: contractors } = useMasterOptions('contractors');

  const defaultRate =
    (contractors?.find((c) => c.id === contractorId)?.defaultRatePaisePerDozen as number | undefined) ?? null;

  const save = useMutation({
    mutationFn: () =>
      api.post('/api/jobs', {
        issueDate,
        contractorId,
        modelId,
        colorId,
        notes,
        lines: lines
          .filter((l) => l.sizeId && l.qtyPcs)
          .map((l) => ({
            sizeId: l.sizeId,
            qtyIssuedPcs: l.qtyPcs,
            unitEntered: 'dozens',
            ratePaisePerDozen: l.rate ?? defaultRate ?? 0,
          })),
      }),
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Save failed.'),
  });

  return (
    <Modal title="New job card" open={open} onClose={onClose} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!contractorId || !modelId || !colorId) {
            setError('Pick contractor, model and color.');
            return;
          }
          if (!lines.some((l) => l.sizeId && l.qtyPcs)) {
            setError('Add at least one size with a quantity.');
            return;
          }
          save.mutate();
        }}
        className="space-y-4"
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Issue date">
            <TextInput type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} required />
          </Field>
          <Field label="Contractor" hint={defaultRate != null ? `Default rate ${formatPaise(defaultRate)}/dz` : undefined}>
            <MasterSelect master="contractors" value={contractorId} onChange={setContractorId} />
          </Field>
          <Field label="Model">
            <MasterSelect master="models" value={modelId} onChange={setModelId} />
          </Field>
          <Field label="Color">
            <MasterSelect master="colors" value={colorId} onChange={setColorId} />
          </Field>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium text-gray-700">Sizes to issue (from cut stock)</p>
          <div className="space-y-2">
            {lines.map((line, i) => (
              <div key={i} className="flex flex-wrap items-end gap-2">
                <div className="w-28">
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
                <div className="min-w-[12rem] flex-1">
                  <DzPcInput
                    pieces={line.qtyPcs}
                    onChange={(pcs) => {
                      const next = [...lines];
                      next[i] = { ...line, qtyPcs: pcs };
                      setLines(next);
                    }}
                  />
                </div>
                <div className="w-32">
                  <MoneyInput
                    paise={line.rate ?? defaultRate}
                    onChange={(p) => {
                      const next = [...lines];
                      next[i] = { ...line, rate: p };
                      setLines(next);
                    }}
                    placeholder="rate/dz"
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
          <Button
            type="button"
            variant="secondary"
            className="mt-2"
            onClick={() => setLines([...lines, { sizeId: null, qtyPcs: null, rate: null }])}
          >
            + Add size
          </Button>
        </div>

        <Field label="Notes">
          <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" disabled={save.isPending} className="w-full">
          {save.isPending ? 'Issuing…' : 'Issue job card'}
        </Button>
      </form>
    </Modal>
  );
}

type ReceiptRow = {
  id: number;
  docNo: string;
  receiptDate: string;
  sizeCode: string;
  qtyPcs: number;
  returnType: string;
};

function JobDetailModal({
  job,
  onClose,
  onChanged,
  canWrite,
  isAdmin,
}: {
  job: JobCard;
  onClose: () => void;
  onChanged: () => void;
  canWrite: boolean;
  isAdmin: boolean;
}) {
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const { data: receipts } = useQuery({
    queryKey: ['jobs', job.id, 'receipts'],
    queryFn: () => api.get<{ items: ReceiptRow[] }>(`/api/jobs/${job.id}/receipts`),
  });

  const active = job.status === 'open' || job.status === 'partially_received';

  return (
    <Modal title={`${job.docNo} — ${job.contractorName}`} open onClose={onClose} wide>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-sm text-gray-500">
          <JobStatusBadge status={job.status} />
          <span>
            {formatBusinessDate(job.issueDate)} · {job.modelCode} {job.colorName} · job cost{' '}
            {formatPaise(job.jobCostPaise)}
          </span>
        </div>
        {job.closeNote && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">Closed: {job.closeNote}</p>
        )}

        <div className="overflow-x-auto rounded-xl border border-gray-200">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-400">
                <th className="px-3 py-2">Size</th>
                <th className="px-3 py-2">Issued</th>
                <th className="px-3 py-2">Received</th>
                <th className="px-3 py-2">Returned</th>
                <th className="px-3 py-2">Pending</th>
                <th className="px-3 py-2">Rate/dz</th>
              </tr>
            </thead>
            <tbody>
              {job.lines.map((l) => (
                <tr key={l.id} className="border-b border-gray-100 last:border-0">
                  <td className="px-3 py-2 font-medium">{l.sizeCode}</td>
                  <td className="px-3 py-2">{formatPieces(l.qtyIssuedPcs)}</td>
                  <td className="px-3 py-2">{formatPieces(l.receivedPcs)}</td>
                  <td className="px-3 py-2">{l.returnedPcs ? formatPieces(l.returnedPcs) : '—'}</td>
                  <td className="px-3 py-2">
                    {l.excessPcs > 0 ? (
                      <Badge tone="blue">+{formatPieces(l.excessPcs)} excess</Badge>
                    ) : l.pendingPcs > 0 ? (
                      <span className="font-semibold text-amber-700">{formatPieces(l.pendingPcs)}</span>
                    ) : (
                      <Badge tone="green">settled</Badge>
                    )}
                  </td>
                  <td className="px-3 py-2 text-gray-500">{formatPaise(l.ratePaisePerDozen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div>
          <p className="mb-1 text-sm font-semibold text-gray-700">Receipts</p>
          {receipts?.items.length === 0 && <p className="text-sm text-gray-400">None yet.</p>}
          <ul className="space-y-1 text-sm">
            {receipts?.items.map((r) => (
              <li key={`${r.id}-${r.sizeCode}-${r.returnType}-${r.qtyPcs}`} className="flex flex-wrap gap-2 text-gray-600">
                <span className="font-mono text-xs text-gray-400">{r.docNo}</span>
                <span>{formatBusinessDate(r.receiptDate)}</span>
                <span className="font-medium">
                  {r.sizeCode} · {formatPieces(r.qtyPcs)}
                </span>
                {r.returnType === 'unstitched_return' && <Badge tone="amber">unstitched return</Badge>}
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-wrap gap-2">
          {canWrite && active && (
            <Button onClick={() => setReceiveOpen(true)}>Receive goods</Button>
          )}
          {isAdmin && active && (
            <Button variant="danger" onClick={() => setCloseOpen(true)}>
              Close with discrepancy
            </Button>
          )}
          <Button variant="secondary" className="ml-auto" onClick={onClose}>
            Close window
          </Button>
        </div>
      </div>

      {receiveOpen && (
        <ReceiveModal
          job={job}
          onClose={() => setReceiveOpen(false)}
          onDone={() => {
            setReceiveOpen(false);
            onChanged();
          }}
        />
      )}
      {closeOpen && (
        <CloseModal
          job={job}
          onClose={() => setCloseOpen(false)}
          onDone={() => {
            setCloseOpen(false);
            onChanged();
            onClose();
          }}
        />
      )}
    </Modal>
  );
}

function ReceiveModal({ job, onClose, onDone }: { job: JobCard; onClose: () => void; onDone: () => void }) {
  const [receiptDate, setReceiptDate] = useState(todayIST());
  const [rows, setRows] = useState(
    job.lines
      .filter((l) => l.pendingPcs > 0 || l.excessPcs === 0)
      .map((l) => ({
        line: l,
        qtyPcs: null as number | null,
        returnType: 'stitched',
        discrepancyReason: '',
        discrepancyNote: '',
      })),
  );
  const [error, setError] = useState('');

  const save = useMutation({
    mutationFn: () =>
      api.post(`/api/jobs/${job.id}/receipts`, {
        receiptDate,
        notes: '',
        lines: rows
          .filter((r) => r.qtyPcs)
          .map((r) => ({
            jobCardLineId: r.line.id,
            qtyPcs: r.qtyPcs,
            returnType: r.returnType,
            discrepancyReason: r.discrepancyReason || null,
            discrepancyNote: r.discrepancyNote,
          })),
      }),
    onSuccess: () => onDone(),
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Save failed.'),
  });

  return (
    <Modal title={`Receive against ${job.docNo}`} open onClose={onClose} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!rows.some((r) => r.qtyPcs)) {
            setError('Enter at least one received quantity.');
            return;
          }
          save.mutate();
        }}
        className="space-y-4"
      >
        <Field label="Receipt date">
          <TextInput type="date" value={receiptDate} onChange={(e) => setReceiptDate(e.target.value)} required />
        </Field>
        <div className="space-y-3">
          {rows.map((r, i) => {
            const excess =
              r.returnType === 'stitched' && r.qtyPcs != null && r.qtyPcs > r.line.pendingPcs
                ? r.qtyPcs - r.line.pendingPcs
                : 0;
            return (
              <div key={r.line.id} className="rounded-xl border border-gray-200 p-3">
                <div className="mb-2 flex items-center justify-between text-sm">
                  <span className="font-semibold">{r.line.sizeCode}</span>
                  <span className="text-gray-500">
                    pending {formatPieces(r.line.pendingPcs)} of {formatPieces(r.line.qtyIssuedPcs)}
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <DzPcInput
                    pieces={r.qtyPcs}
                    onChange={(pcs) => {
                      const next = [...rows];
                      next[i] = { ...r, qtyPcs: pcs };
                      setRows(next);
                    }}
                  />
                  <Select
                    aria-label={`Type for ${r.line.sizeCode}`}
                    value={r.returnType}
                    onChange={(e) => {
                      const next = [...rows];
                      next[i] = { ...r, returnType: e.target.value };
                      setRows(next);
                    }}
                  >
                    <option value="stitched">Stitched (finished)</option>
                    <option value="unstitched_return">Unstitched return (cloth back)</option>
                  </Select>
                </div>
                {excess > 0 && (
                  <div className="mt-2 space-y-2">
                    <p className="text-xs font-medium text-blue-700">
                      +{formatPieces(excess)} more than pending — pick a reason:
                    </p>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <Select
                        aria-label={`Excess reason for ${r.line.sizeCode}`}
                        value={r.discrepancyReason}
                        onChange={(e) => {
                          const next = [...rows];
                          next[i] = { ...r, discrepancyReason: e.target.value };
                          setRows(next);
                        }}
                      >
                        <option value="">— reason —</option>
                        {JOB_DISCREPANCY_REASONS.map((reason) => (
                          <option key={reason} value={reason}>
                            {enumLabel(reason)}
                          </option>
                        ))}
                      </Select>
                      <TextInput
                        placeholder="Note (optional)"
                        value={r.discrepancyNote}
                        onChange={(e) => {
                          const next = [...rows];
                          next[i] = { ...r, discrepancyNote: e.target.value };
                          setRows(next);
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" disabled={save.isPending} className="w-full">
          {save.isPending ? 'Saving…' : 'Record receipt'}
        </Button>
      </form>
    </Modal>
  );
}

function CloseModal({ job, onClose, onDone }: { job: JobCard; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('missing_pieces');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  const close = useMutation({
    mutationFn: () => api.post(`/api/jobs/${job.id}/close`, { reason, note }),
    onSuccess: () => onDone(),
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Close failed.'),
  });

  return (
    <Modal title={`Close ${job.docNo} with discrepancy`} open onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          close.mutate();
        }}
        className="space-y-4"
      >
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
          {formatPieces(job.pendingPcs)} still pending will be written off as a contractor
          shortage. Only Admin can do this, and it is recorded permanently.
        </p>
        <Field label="Reason">
          <Select value={reason} onChange={(e) => setReason(e.target.value)}>
            {JOB_DISCREPANCY_REASONS.map((r) => (
              <option key={r} value={r}>
                {enumLabel(r)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="What happened? (required)">
          <TextInput value={note} onChange={(e) => setNote(e.target.value)} required minLength={3} />
        </Field>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" variant="danger" disabled={close.isPending} className="w-full">
          {close.isPending ? 'Closing…' : 'Close job with discrepancy'}
        </Button>
      </form>
    </Modal>
  );
}
