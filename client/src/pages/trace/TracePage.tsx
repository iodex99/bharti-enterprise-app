import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatPieces } from '@shared';
import { api } from '../../api/client';
import { EmptyState, Field, Select, Spinner } from '../../components/ui';

type TraceNode = {
  type: string;
  label: string;
  detail: string;
  qtyPcs?: number;
  children: TraceNode[];
};

type FgLot = {
  packIssueId: number;
  docNo: string;
  modelCode: string;
  colorName: string;
  sizeCode: string;
  /** the size-code the goods carry everywhere else, e.g. "315-HR" */
  sizeCodeLabel: string;
  qtyPcs: number;
};
type PurchaseRow = { id: number; docNo: string; vendorName: string; modelCode: string; colorName: string };

const NODE_ICON: Record<string, string> = {
  fg: '🎁',
  checking: '🔍',
  jobwork: '🧵',
  cutting: '✂️',
  cutting_line: '📏',
  purchase: '🧾',
  opening: '🧮',
};

export default function TracePage() {
  const [mode, setMode] = useState<'backward' | 'forward'>('backward');
  const [fgLotId, setFgLotId] = useState<number | null>(null);
  const [purchaseId, setPurchaseId] = useState<number | null>(null);

  const { data: fgLots } = useQuery({
    queryKey: ['trace', 'fg-lots'],
    queryFn: () => api.get<{ items: FgLot[] }>('/api/trace/fg-lots'),
  });
  const { data: purchases } = useQuery({
    queryKey: ['purchases', false],
    queryFn: () => api.get<{ items: PurchaseRow[] }>('/api/purchases'),
  });

  const activeId = mode === 'backward' ? fgLotId : purchaseId;
  const { data: trace, isLoading } = useQuery({
    queryKey: ['trace', mode, activeId],
    queryFn: () =>
      api.get<{ tree: TraceNode }>(
        mode === 'backward' ? `/api/trace/fg/${fgLotId}` : `/api/trace/purchase/${purchaseId}`,
      ),
    enabled: !!activeId,
  });

  return (
    <div className="p-4 sm:p-6">
      <h1 className="text-xl font-bold text-gray-900">Traceability</h1>
      <p className="mb-4 text-sm text-gray-500">
        Follow any batch through the whole chain — finished goods back to the cloth vendor,
        or a cloth purchase forward to finished goods.
      </p>

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Direction">
          <Select value={mode} onChange={(e) => setMode(e.target.value as 'backward' | 'forward')}>
            <option value="backward">Finished goods → back to vendor</option>
            <option value="forward">Purchase → forward to production</option>
          </Select>
        </Field>
        {mode === 'backward' ? (
          <Field label="Finished goods batch">
            <Select
              value={fgLotId ?? ''}
              onChange={(e) => setFgLotId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="" disabled>
                — pick a batch —
              </option>
              {fgLots?.items.map((lot) => (
                <option key={lot.packIssueId} value={lot.packIssueId}>
                  {lot.sizeCodeLabel} {lot.colorName} · {formatPieces(lot.qtyPcs)} in stock ·{' '}
                  {lot.docNo}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label="Purchase batch">
            <Select
              value={purchaseId ?? ''}
              onChange={(e) => setPurchaseId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="" disabled>
                — pick a purchase —
              </option>
              {purchases?.items.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.docNo} · {p.modelCode} {p.colorName} · from {p.vendorName}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>

      {!activeId && (
        <EmptyState
          title="Pick a batch to trace"
          hint={
            mode === 'backward'
              ? 'You will see who packed, who checked, which contractor stitched, which cutting batch and which cloth purchase it came from.'
              : 'You will see every cutting batch and contractor job made from this cloth.'
          }
        />
      )}
      {activeId && isLoading && <Spinner />}
      {activeId && trace && (
        <div className="rounded-2xl border border-gray-200 bg-white p-4">
          <TreeNode node={trace.tree} depth={0} />
          <p className="mt-4 border-t border-gray-100 pt-3 text-xs text-gray-400">
            Quantities follow first-in-first-out allocation — after cutting, physical pieces mix
            in bins, so downstream links are the system's honest best allocation.
          </p>
        </div>
      )}
    </div>
  );
}

function TreeNode({ node, depth }: { node: TraceNode; depth: number }) {
  const [open, setOpen] = useState(depth < 4);
  const hasChildren = node.children.length > 0;
  return (
    <div className={depth > 0 ? 'ml-5 border-l border-gray-200 pl-4' : ''}>
      <div className="flex items-start gap-2 py-1.5">
        {hasChildren ? (
          <button
            onClick={() => setOpen(!open)}
            className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-xs text-gray-400 hover:bg-gray-100"
            aria-label={open ? 'Collapse' : 'Expand'}
          >
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="w-5 shrink-0" />
        )}
        <span aria-hidden className="mt-0.5">
          {NODE_ICON[node.type] ?? '•'}
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900">
            {node.label}
            {node.qtyPcs != null && (
              <span className="ml-2 rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-700">
                {formatPieces(node.qtyPcs)}
              </span>
            )}
          </p>
          <p className="text-xs text-gray-500">{node.detail}</p>
        </div>
      </div>
      {open && hasChildren && (
        <div>
          {node.children.map((child, i) => (
            <TreeNode key={i} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
