import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatBusinessDate,
  formatPieces,
  label as enumLabel,
  PACK_SHORT_REASONS,
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

type PackIssue = {
  id: number;
  docNo: string;
  issueDate: string;
  status: 'open' | 'completed';
  staffName: string;
  modelCode: string;
  colorName: string;
  sizeCode: string;
  qtyPcs: number;
  packedPcs: number;
  shortPcs: number;
  pendingPcs: number;
  voidedAt: string | null;
};

export default function PackingPage() {
  const { user } = useAuth();
  const canWrite = user?.role === 'admin' || user?.role === 'operator';
  const isAdmin = user?.role === 'admin';
  const queryClient = useQueryClient();
  const [issueOpen, setIssueOpen] = useState(false);
  const [resultFor, setResultFor] = useState<PackIssue | null>(null);
  const [voidFor, setVoidFor] = useState<PackIssue | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['packing'],
    queryFn: () => api.get<{ items: PackIssue[] }>('/api/packing'),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['packing'] });
    void queryClient.invalidateQueries({ queryKey: ['stock'] });
  };

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Packing</h1>
          <p className="text-sm text-gray-500">
            Packing checked goods into finished stock (Module 8)
          </p>
        </div>
        {canWrite && <Button onClick={() => setIssueOpen(true)}>+ Issue to packer</Button>}
      </div>

      <DataTable
        columns={[
          { key: 'docNo', header: 'Doc', className: 'font-mono text-xs font-medium' },
          { key: 'issueDate', header: 'Date', render: (r) => formatBusinessDate(r.issueDate) },
          { key: 'staffName', header: 'Packer' },
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
            header: 'Packed / Short',
            render: (r) => (
              <span className="space-x-1 whitespace-nowrap">
                <Badge tone="green">{formatPieces(r.packedPcs)}</Badge>
                <Badge tone="red">{formatPieces(r.shortPcs)}</Badge>
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
        emptyTitle="Nothing issued for packing yet"
        emptyHint={canWrite ? 'Pass goods through checking first, then issue them to a packer.' : undefined}
        actions={(row) => (
          <>
            {canWrite && row.status === 'open' && (
              <Button variant="ghost" className="text-violet-700" onClick={() => setResultFor(row)}>
                Record result
              </Button>
            )}
            {isAdmin && row.packedPcs + row.shortPcs === 0 && (
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
        entity="pack issue"
        target={voidFor ? { id: voidFor.id, label: voidFor.docNo, url: `/api/packing/${voidFor.id}/void` } : null}
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
  const packers = staff?.filter((s) => s.role === 'packer' || s.role === 'both');

  const save = useMutation({
    mutationFn: () =>
      api.post('/api/packing', { issueDate, staffId, modelId, colorId, sizeId, qtyPcs, notes: '' }),
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Save failed.'),
  });

  return (
    <Modal title="Issue goods for packing" open={open} onClose={onClose}>
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
        <Field label="Packer" hint="Staff with role Checker + Packer can do both jobs">
          <Select value={staffId ?? ''} onChange={(e) => setStaffId(e.target.value ? Number(e.target.value) : null)}>
            <option value="" disabled>
              — select packer —
            </option>
            {packers?.map((s) => (
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
          {save.isPending ? 'Issuing…' : 'Issue for packing'}
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
  issue: PackIssue | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [resultDate, setResultDate] = useState(todayIST());
  const [packed, setPacked] = useState<number | null>(null);
  const [short, setShort] = useState<number | null>(null);
  const [shortReason, setShortReason] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');

  const save = useMutation({
    mutationFn: () =>
      api.post(`/api/packing/${issue!.id}/results`, {
        resultDate,
        qtyPacked: packed ?? 0,
        qtyShort: short ?? 0,
        shortReason: short ? shortReason || null : null,
        notes,
      }),
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Save failed.'),
  });

  if (!issue) return null;

  return (
    <Modal title={`Packing result — ${issue.docNo}`} open onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="space-y-4"
      >
        <p className="rounded-lg bg-violet-50 px-3 py-2 text-sm text-violet-900">
          {issue.staffName} holds <strong>{formatPieces(issue.pendingPcs)}</strong> of{' '}
          {issue.modelCode} {issue.colorName} {issue.sizeCode}.
        </p>
        <Field label="Result date">
          <TextInput type="date" value={resultDate} onChange={(e) => setResultDate(e.target.value)} required />
        </Field>
        <Field label="Packed (goes to finished goods)">
          <DzPcInput pieces={packed} onChange={setPacked} />
        </Field>
        <Field label="Short / lost">
          <DzPcInput pieces={short} onChange={setShort} />
        </Field>
        {(short ?? 0) > 0 && (
          <Field label="Shortage reason">
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
        <Field label="Notes">
          <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" disabled={save.isPending} className="w-full">
          {save.isPending ? 'Saving…' : 'Record packing result'}
        </Button>
      </form>
    </Modal>
  );
}
