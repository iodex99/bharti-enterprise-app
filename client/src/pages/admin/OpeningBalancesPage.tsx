import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatBusinessDate,
  formatLen,
  formatPieces,
  label as stageLabel,
  STAGES,
  todayIST,
} from '@shared';
import { api, ApiError } from '../../api/client';
import { DataTable } from '../../components/DataTable';
import { Badge, Button, ErrorText, Field, Modal, Select, TextInput } from '../../components/ui';
import { DzPcInput, InchesInput, YardsInput } from '../../components/inputs';
import { MasterSelect } from '../../components/MasterSelect';
import { VoidModal } from '../purchases/PurchasesPage';

type OpeningRow = {
  id: number;
  docNo: string;
  balanceDate: string;
  stage: string;
  modelCode: string;
  colorName: string;
  sizeCode: string | null;
  contractorName: string | null;
  qty: number;
  note: string;
  voidedAt: string | null;
};

export default function OpeningBalancesPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [voidFor, setVoidFor] = useState<OpeningRow | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['opening-balances'],
    queryFn: () => api.get<{ items: OpeningRow[] }>('/api/opening-balances'),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['opening-balances'] });
    void queryClient.invalidateQueries({ queryKey: ['stock'] });
  };

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Opening Balances</h1>
          <p className="text-sm text-gray-500">
            Bring existing register stock into the system at go-live (admin only)
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>+ Add opening stock</Button>
      </div>

      <DataTable
        columns={[
          { key: 'docNo', header: 'Doc', className: 'font-mono text-xs' },
          {
            key: 'balanceDate',
            header: 'As of',
            render: (r) => formatBusinessDate(r.balanceDate),
          },
          {
            key: 'stage',
            header: 'Stage',
            render: (r) => <Badge tone="violet">{stageLabel(r.stage)}</Badge>,
          },
          {
            key: 'item',
            header: 'Item',
            value: (r) => `${r.modelCode} ${r.colorName} ${r.sizeCode ?? ''}`,
            render: (r) => (
              <span>
                <span className="font-medium">{r.modelCode}</span>{' '}
                <span className="text-gray-500">
                  {r.colorName}
                  {r.sizeCode ? ` · ${r.sizeCode}` : ''}
                  {r.contractorName ? ` · with ${r.contractorName}` : ''}
                </span>
              </span>
            ),
          },
          {
            key: 'qty',
            header: 'Quantity',
            className: 'font-semibold',
            render: (r) =>
              r.voidedAt ? (
                <Badge tone="red">voided</Badge>
              ) : r.stage === 'RAW' ? (
                formatLen(r.qty)
              ) : (
                formatPieces(r.qty)
              ),
          },
          { key: 'note', header: 'Note', className: 'text-gray-500' },
        ]}
        rows={data?.items}
        loading={isLoading}
        emptyTitle="No opening balances entered"
        emptyHint="Use this once at go-live to load current stock from the paper registers."
        actions={(row) =>
          row.voidedAt ? null : (
            <Button variant="ghost" className="text-red-600" onClick={() => setVoidFor(row)}>
              Void
            </Button>
          )
        }
      />

      <NewOpeningModal
        key={String(createOpen)}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onDone={invalidate}
      />
      <VoidModal
        entity="opening balance"
        target={
          voidFor
            ? {
                id: voidFor.id,
                label: voidFor.docNo,
                url: `/api/opening-balances/${voidFor.id}/void`,
              }
            : null
        }
        onClose={() => setVoidFor(null)}
        onDone={invalidate}
      />
    </div>
  );
}

function NewOpeningModal({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [balanceDate, setBalanceDate] = useState(todayIST());
  const [stage, setStage] = useState<string>('RAW');
  const [modelCode, setModelCode] = useState('');
  const [colorId, setColorId] = useState<number | null>(null);
  const [sizeId, setSizeId] = useState<number | null>(null);
  const [contractorId, setContractorId] = useState<number | null>(null);
  const [qty, setQty] = useState<number | null>(null);
  const [widthInchC, setWidthInchC] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  const save = useMutation({
    mutationFn: () =>
      api.post('/api/opening-balances', {
        balanceDate,
        stage,
        modelCode: stage === 'RAW' ? null : modelCode.trim().toUpperCase(), // no code on raw cloth
        colorId,
        sizeId: stage === 'RAW' ? null : sizeId,
        contractorId: stage === 'WIP' ? contractorId : null,
        qty,
        widthInchC: stage === 'RAW' ? widthInchC : null,
        note,
      }),
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Save failed.'),
  });

  return (
    <Modal title="Add opening stock" open={open} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="space-y-4"
      >
        <Field label="Stock as of">
          <TextInput
            type="date"
            value={balanceDate}
            onChange={(e) => setBalanceDate(e.target.value)}
            required
          />
        </Field>
        <Field label="Stage">
          <Select value={stage} onChange={(e) => setStage(e.target.value)}>
            {STAGES.map((s) => (
              <option key={s} value={s}>
                {stageLabel(s)}
              </option>
            ))}
          </Select>
        </Field>
        {stage !== 'RAW' && (
          <Field
            label="Code number"
            hint="Typed like at cutting — new codes are created automatically"
          >
            <TextInput
              value={modelCode}
              onChange={(e) => setModelCode(e.target.value)}
              placeholder="e.g. 315"
            />
          </Field>
        )}
        <Field
          label="Color"
          hint={stage === 'RAW' ? 'Raw cloth gets its code at cutting' : undefined}
        >
          <MasterSelect master="colors" value={colorId} onChange={setColorId} />
        </Field>
        {stage !== 'RAW' && (
          <Field label="Size">
            <MasterSelect master="sizes" value={sizeId} onChange={setSizeId} />
          </Field>
        )}
        {stage === 'WIP' && (
          <Field label="With contractor">
            <MasterSelect master="contractors" value={contractorId} onChange={setContractorId} />
          </Field>
        )}
        <Field label={stage === 'RAW' ? 'Length (yards)' : 'Quantity'}>
          {stage === 'RAW' ? (
            <YardsInput inchC={qty} onChange={setQty} />
          ) : (
            <DzPcInput pieces={qty} onChange={setQty} />
          )}
        </Field>
        {stage === 'RAW' && (
          <Field label="Cloth width (inches)">
            <InchesInput inchC={widthInchC} onChange={setWidthInchC} placeholder="e.g. 44" />
          </Field>
        )}
        <Field label="Note">
          <TextInput
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. from register page 42"
          />
        </Field>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" disabled={save.isPending} className="w-full">
          {save.isPending ? 'Saving…' : 'Add opening stock'}
        </Button>
      </form>
    </Modal>
  );
}
