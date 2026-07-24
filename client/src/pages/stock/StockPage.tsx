import { useQuery } from '@tanstack/react-query';
import { NavLink, useParams } from 'react-router';
import clsx from 'clsx';
import { formatInchC, formatLen, formatPieces, label as stageLabel, STAGES } from '@shared';
import { api } from '../../api/client';
import { DataTable, type Column } from '../../components/DataTable';

type SummaryRow = { stage: string; qty: number; combos: number };
type StockRow = {
  modelId: number;
  modelCode: string;
  modelName: string;
  colorId: number;
  colorName: string;
  sizeId: number | null;
  sizeCode: string | null;
  contractorId: number | null;
  contractorName: string | null;
  qty: number;
};

type RawLot = {
  lotType: string;
  lotId: number;
  colorName: string;
  purchaseDocNo: string | null;
  purchaseDate: string | null;
  vendorName: string | null;
  openingDocNo: string | null;
  widthInchC: number | null;
  qtyInchC: number;
};

/** Inventory at every stage — the six layers + rejected (spec: Inventory Layers). */
export default function StockPage() {
  const { stage: stageParam = 'RAW' } = useParams();
  const stage = stageParam.toUpperCase();

  const { data: summary } = useQuery({
    queryKey: ['stock', 'summary'],
    queryFn: () => api.get<{ stages: SummaryRow[] }>('/api/stock/summary'),
    refetchInterval: 60_000,
  });

  return (
    <div className="p-4 sm:p-6">
      <h1 className="text-xl font-bold text-gray-900">Inventory</h1>
      <p className="mb-4 text-sm text-gray-500">
        Live stock at every stage. Stock only moves through recorded transactions.
      </p>

      <div className="mb-5 flex gap-2 overflow-x-auto pb-1">
        {STAGES.map((s) => {
          const row = summary?.stages.find((x) => x.stage === s);
          return (
            <NavLink
              key={s}
              to={`/stock/${s.toLowerCase()}`}
              className={({ isActive }) =>
                clsx(
                  'min-w-[7.5rem] shrink-0 rounded-xl border px-3 py-2 text-left',
                  isActive
                    ? 'border-violet-400 bg-violet-50'
                    : 'border-gray-200 bg-white hover:border-gray-300',
                )
              }
            >
              <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                {stageLabel(s)}
              </p>
              <p className="text-base font-bold text-gray-900">
                {row ? (s === 'RAW' ? formatLen(row.qty) : formatPieces(row.qty)) : '…'}
              </p>
            </NavLink>
          );
        })}
      </div>

      {stage === 'RAW' ? <RawStock /> : <StageStock stage={stage} />}
    </div>
  );
}

function RawStock() {
  const { data, isLoading } = useQuery({
    queryKey: ['stock', 'raw'],
    queryFn: () => api.get<{ lots: RawLot[] }>('/api/stock/raw'),
  });

  const rows = data?.lots.map((l) => ({ ...l, id: `${l.lotType}-${l.lotId}` }));

  return (
    <DataTable
      columns={[
        {
          key: 'batch',
          header: 'Batch',
          className: 'font-mono text-xs',
          value: (r) => r.purchaseDocNo ?? r.openingDocNo ?? '',
          render: (r) => r.purchaseDocNo ?? `${r.openingDocNo} (opening)`,
        },
        // raw cloth has no code — it is given at cutting
        { key: 'colorName', header: 'Color', className: 'font-medium' },
        { key: 'vendorName', header: 'Vendor', render: (r) => r.vendorName ?? '—' },
        {
          key: 'widthInchC',
          header: 'Width',
          render: (r) => (r.widthInchC ? formatInchC(r.widthInchC) : '—'),
          value: (r) => r.widthInchC ?? 0,
        },
        {
          key: 'qtyInchC',
          header: 'Available',
          className: 'font-semibold',
          render: (r) => formatLen(r.qtyInchC),
          value: (r) => r.qtyInchC,
        },
      ]}
      rows={rows}
      loading={isLoading}
      facets={[
        { key: 'color', label: 'Color', value: (r) => r.colorName },
        { key: 'vendor', label: 'Vendor', value: (r) => r.vendorName },
      ]}
      emptyTitle="No raw material in stock"
      emptyHint="Record a purchase or an opening balance to see cloth here."
    />
  );
}

function StageStock({ stage }: { stage: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['stock', stage],
    queryFn: () => api.get<{ items: StockRow[] }>(`/api/stock/${stage}`),
  });

  type Row = StockRow & { id: number };
  const rows: Row[] | undefined = data?.items.map((r, i) => ({ ...r, id: i }));
  const showContractor = stage === 'WIP';

  const columns: Column<Row>[] = [
    {
      key: 'item',
      header: 'Code / Color',
      value: (r) => `${r.modelCode} ${r.colorName}`,
      render: (r) => (
        <span>
          <span className="font-medium">{r.modelCode}</span>{' '}
          <span className="text-gray-500">{r.colorName}</span>
        </span>
      ),
    },
    { key: 'sizeCode', header: 'Size', render: (r) => r.sizeCode ?? '—' },
  ];
  if (showContractor) {
    columns.push({
      key: 'contractorName',
      header: 'With contractor',
      render: (r) => r.contractorName ?? '—',
    });
  }
  columns.push({
    key: 'qty',
    header: 'Quantity',
    className: 'font-semibold',
    render: (r) => formatPieces(r.qty),
    value: (r) => r.qty,
  });

  return (
    <DataTable
      columns={columns}
      rows={rows}
      loading={isLoading}
      facets={[
        { key: 'model', label: 'Code', value: (r) => r.modelCode },
        { key: 'color', label: 'Color', value: (r) => r.colorName },
        { key: 'size', label: 'Size', value: (r) => r.sizeCode },
      ]}
      emptyTitle={`Nothing in ${stageLabel(stage)} right now`}
    />
  );
}
