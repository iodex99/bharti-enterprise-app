import { useQuery } from '@tanstack/react-query';
import { formatBusinessDate, formatPaise } from '@shared';
import { api } from '../../api/client';
import { DataTable } from '../../components/DataTable';
import { Badge } from '../../components/ui';

type DueRow = {
  contractorId: number;
  name: string;
  mobile: string;
  jobWorkCostPaise: number;
  paidPaise: number;
  duesPaise: number;
  lastPaymentDate: string | null;
  openJobs: number;
};

/**
 * Pending dues at a glance (ADR-036): who is owed what right now, largest first.
 * Payments are recorded on the Contractors page.
 */
export default function DuesPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['contractors', 'dues'],
    queryFn: () => api.get<{ items: DueRow[]; totalDuesPaise: number }>('/api/contractors/dues'),
  });

  const rows = data?.items.map((r) => ({ ...r, id: r.contractorId }));

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Pending Dues</h1>
          <p className="text-sm text-gray-500">
            What each contractor is still owed (job-work cost − payments). Record payments
            on the Contractors page.
          </p>
        </div>
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-right">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">
            Total pending
          </p>
          <p className="text-lg font-bold text-amber-900">
            {data ? formatPaise(data.totalDuesPaise) : '…'}
          </p>
        </div>
      </div>

      <DataTable
        columns={[
          { key: 'name', header: 'Contractor', className: 'font-medium' },
          { key: 'mobile', header: 'Mobile', className: 'text-gray-500' },
          {
            key: 'jobWorkCostPaise',
            header: 'Job-work cost',
            render: (r) => formatPaise(r.jobWorkCostPaise),
            value: (r) => r.jobWorkCostPaise,
          },
          {
            key: 'paidPaise',
            header: 'Paid',
            render: (r) => formatPaise(r.paidPaise),
            value: (r) => r.paidPaise,
          },
          {
            key: 'duesPaise',
            header: 'Pending dues',
            className: 'font-bold',
            render: (r) => <span className="text-amber-800">{formatPaise(r.duesPaise)}</span>,
            value: (r) => r.duesPaise,
          },
          {
            key: 'lastPaymentDate',
            header: 'Last payment',
            render: (r) => (r.lastPaymentDate ? formatBusinessDate(r.lastPaymentDate) : '—'),
            value: (r) => r.lastPaymentDate ?? '',
          },
          {
            key: 'openJobs',
            header: 'Open jobs',
            render: (r) => (r.openJobs > 0 ? <Badge tone="amber">{r.openJobs}</Badge> : '—'),
            value: (r) => r.openJobs,
          },
        ]}
        rows={rows}
        loading={isLoading}
        emptyTitle="No pending dues"
        emptyHint="Every contractor is fully paid up."
      />
    </div>
  );
}
