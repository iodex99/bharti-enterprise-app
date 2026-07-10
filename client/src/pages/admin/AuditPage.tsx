import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { formatTimestampIST } from '@shared';
import { Badge, Button, EmptyState, Spinner } from '../../components/ui';

type AuditEntry = {
  id: number;
  user: string | null;
  action: string;
  entityType: string;
  entityId: number | null;
  old: unknown;
  new: unknown;
  ip: string | null;
  at: string;
};

const ACTION_TONE: Record<string, 'green' | 'blue' | 'red' | 'amber' | 'gray'> = {
  create: 'green',
  update: 'blue',
  void: 'red',
  deactivate: 'red',
  reactivate: 'green',
  login: 'gray',
  logout: 'gray',
  reset_password: 'amber',
  change_password: 'amber',
};

export default function AuditPage() {
  const [page, setPage] = useState(0);
  const limit = 50;
  const { data, isLoading } = useQuery({
    queryKey: ['audit', page],
    queryFn: () => api.get<{ entries: AuditEntry[] }>(`/api/audit?limit=${limit}&offset=${page * limit}`),
  });

  return (
    <div className="p-4 sm:p-6">
      <h1 className="text-xl font-bold text-gray-900">Audit log</h1>
      <p className="mb-4 text-sm text-gray-500">Every change, who made it, and when</p>

      {isLoading && <Spinner />}
      {data && data.entries.length === 0 && page === 0 && (
        <EmptyState title="No audit entries yet" />
      )}
      {data && data.entries.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-gray-200 bg-white">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-400">
                <th className="px-4 py-3">When (IST)</th>
                <th className="px-4 py-3">User</th>
                <th className="px-4 py-3">Action</th>
                <th className="px-4 py-3">Record</th>
                <th className="px-4 py-3">Change</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((e) => (
                <tr key={e.id} className="border-b border-gray-100 align-top last:border-0">
                  <td className="whitespace-nowrap px-4 py-2.5 text-gray-500">
                    {formatTimestampIST(e.at)}
                  </td>
                  <td className="px-4 py-2.5 font-medium text-gray-800">{e.user ?? '—'}</td>
                  <td className="px-4 py-2.5">
                    <Badge tone={ACTION_TONE[e.action] ?? 'gray'}>{e.action}</Badge>
                  </td>
                  <td className="px-4 py-2.5 text-gray-600">
                    {e.entityType}
                    {e.entityId ? ` #${e.entityId}` : ''}
                  </td>
                  <td className="max-w-[26rem] px-4 py-2.5">
                    <ChangeView oldValue={e.old} newValue={e.new} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-4 flex items-center gap-2">
        <Button variant="secondary" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
          ← Newer
        </Button>
        <Button
          variant="secondary"
          disabled={!data || data.entries.length < limit}
          onClick={() => setPage((p) => p + 1)}
        >
          Older →
        </Button>
      </div>
    </div>
  );
}

function ChangeView({ oldValue, newValue }: { oldValue: unknown; newValue: unknown }) {
  if (oldValue == null && newValue == null) return <span className="text-gray-300">—</span>;
  return (
    <details className="cursor-pointer">
      <summary className="text-xs text-violet-600">view</summary>
      <div className="mt-1 space-y-1 text-xs">
        {oldValue != null && (
          <pre className="overflow-x-auto rounded bg-red-50 p-2 text-red-800">
            {JSON.stringify(oldValue, null, 1)}
          </pre>
        )}
        {newValue != null && (
          <pre className="overflow-x-auto rounded bg-emerald-50 p-2 text-emerald-800">
            {JSON.stringify(newValue, null, 1)}
          </pre>
        )}
      </div>
    </details>
  );
}
