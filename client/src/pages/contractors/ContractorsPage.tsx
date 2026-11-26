import { useQuery } from '@tanstack/react-query';
import { formatPaise, formatPieces } from '@shared';
import { api } from '../../api/client';
import { DataTable } from '../../components/DataTable';
import { Badge, Button } from '../../components/ui';

type ContractorStats = {
  id: number;
  name: string;
  mobile: string;
  isActive: number;
  totalJobs: number;
  openJobs: number;
  discrepancyJobs: number;
  issuedPcs: number;
  receivedPcs: number;
  unstitchedReturnedPcs: number;
  reworkPcs: number;
  missingPcs: number;
  shortagePcs: number;
  excessPcs: number;
  discrepancyPct: number;
  jobWorkCostPaise: number;
  paidPaise: number;
  duesPaise: number;
  avgTurnaroundDays: number | null;
};

/**
 * Contractor performance (the old Contractors page, now a tab of Pending Dues):
 * ranked by discrepancy, with what they delivered, sent-back rework and dues.
 * Payments live in the Payments tab; each contractor's ledger is one tap away.
 */
export function ContractorPerformance({ onOpen }: { onOpen: (id: number) => void }) {
  const { data: analytics, isLoading } = useQuery({
    queryKey: ['contractors', 'analytics'],
    queryFn: () => api.get<{ items: ContractorStats[] }>('/api/contractors/analytics'),
  });

  // performance ranking: lowest discrepancy first, then most delivered
  const ranked = analytics
    ? [...analytics.items]
        .filter((c) => c.totalJobs > 0)
        .sort((a, b) => a.discrepancyPct - b.discrepancyPct || b.receivedPcs - a.receivedPcs)
    : [];

  return (
    <DataTable
      columns={[
        {
          key: 'rank',
          header: '#',
          className: 'w-10 text-gray-400',
          render: (r) => {
            const i = ranked.findIndex((c) => c.id === r.id);
            return i >= 0 ? i + 1 : '—';
          },
          value: (r) => {
            const i = ranked.findIndex((c) => c.id === r.id);
            return i >= 0 ? i + 1 : 9999;
          },
        },
        { key: 'name', header: 'Contractor', className: 'font-medium' },
        { key: 'totalJobs', header: 'Jobs', render: (r) => `${r.totalJobs} (${r.openJobs} open)` },
        { key: 'issuedPcs', header: 'Issued', render: (r) => formatPieces(r.issuedPcs) },
        { key: 'receivedPcs', header: 'Received', render: (r) => formatPieces(r.receivedPcs) },
        {
          key: 'reworkPcs',
          header: 'Rework',
          render: (r) =>
            r.reworkPcs > 0 || r.missingPcs > 0 ? (
              <span className="text-red-700">
                {r.reworkPcs > 0 && <>↩ {formatPieces(r.reworkPcs)}</>}
                {r.missingPcs > 0 && (
                  <span className="ml-1 text-xs">({formatPieces(r.missingPcs)} missing)</span>
                )}
              </span>
            ) : (
              <span className="text-gray-300">—</span>
            ),
          value: (r) => r.reworkPcs,
        },
        {
          key: 'shortExcess',
          header: 'Short / Excess',
          render: (r) => (
            <span>
              {r.shortagePcs > 0 && <Badge tone="red">−{formatPieces(r.shortagePcs)}</Badge>}{' '}
              {r.excessPcs > 0 && <Badge tone="blue">+{formatPieces(r.excessPcs)}</Badge>}
              {r.shortagePcs === 0 && r.excessPcs === 0 && <span className="text-gray-300">—</span>}
            </span>
          ),
        },
        {
          key: 'discrepancyPct',
          header: 'Discrepancy %',
          render: (r) =>
            r.discrepancyPct === 0 ? (
              <Badge tone="green">0%</Badge>
            ) : (
              <Badge tone={r.discrepancyPct > 5 ? 'red' : 'amber'}>{r.discrepancyPct}%</Badge>
            ),
        },
        {
          key: 'avgTurnaroundDays',
          header: 'Avg turnaround',
          render: (r) => (r.avgTurnaroundDays == null ? '—' : `${r.avgTurnaroundDays} days`),
        },
        {
          key: 'jobWorkCostPaise',
          header: 'Job-work cost',
          render: (r) => formatPaise(r.jobWorkCostPaise),
        },
        {
          key: 'duesPaise',
          header: 'Dues',
          className: 'font-semibold',
          render: (r) =>
            r.duesPaise > 0 ? (
              <span className="text-red-700">{formatPaise(r.duesPaise)}</span>
            ) : r.duesPaise < 0 ? (
              <span className="text-blue-700">{formatPaise(-r.duesPaise)} (advance)</span>
            ) : (
              <span className="text-gray-400">{formatPaise(0)}</span>
            ),
        },
      ]}
      rows={analytics?.items}
      loading={isLoading}
      emptyTitle="No contractors yet"
      quickFilters={[
        { key: 'open', label: 'With open jobs', test: (r) => r.openJobs > 0 },
        { key: 'due', label: 'Owed money', test: (r) => r.duesPaise > 0 },
        { key: 'rework', label: 'Had rework', test: (r) => r.reworkPcs > 0 },
      ]}
      onRowClick={(r) => onOpen(r.id)}
      actions={(r) => (
        <Button variant="ghost" onClick={() => onOpen(r.id)}>
          Ledger
        </Button>
      )}
    />
  );
}
