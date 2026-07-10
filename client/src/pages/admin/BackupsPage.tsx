import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { formatTimestampIST } from '@shared';
import { Button, EmptyState, Spinner } from '../../components/ui';

type BackupInfo = { name: string; sizeBytes: number; modifiedAt: string };

export default function BackupsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['backups'],
    queryFn: () => api.get<{ backups: BackupInfo[] }>('/api/system/backups'),
  });

  const backupNow = useMutation({
    mutationFn: () => api.post('/api/system/backups'),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['backups'] }),
  });

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Backups</h1>
          <p className="text-sm text-gray-500">
            Daily at 2:00 AM automatically, before every update, and on demand. Keep a copy of
            the newest file outside this computer.
          </p>
        </div>
        <Button onClick={() => backupNow.mutate()} disabled={backupNow.isPending}>
          {backupNow.isPending ? 'Backing up…' : 'Backup now'}
        </Button>
      </div>

      {isLoading && <Spinner />}
      {data && data.backups.length === 0 && (
        <EmptyState title="No backups yet" hint="Press “Backup now” to create the first one." />
      )}
      {data && data.backups.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-gray-200 bg-white">
          <table className="w-full min-w-[480px] text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-400">
                <th className="px-4 py-3">Backup</th>
                <th className="px-4 py-3">Created (IST)</th>
                <th className="px-4 py-3">Size</th>
                <th className="px-4 py-3 text-right">Download</th>
              </tr>
            </thead>
            <tbody>
              {data.backups.map((b) => (
                <tr key={b.name} className="border-b border-gray-100 last:border-0">
                  <td className="px-4 py-2.5 font-mono text-xs text-gray-700">{b.name}</td>
                  <td className="px-4 py-2.5 text-gray-500">{formatTimestampIST(b.modifiedAt)}</td>
                  <td className="px-4 py-2.5 text-gray-500">
                    {(b.sizeBytes / 1024 / 1024).toFixed(2)} MB
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <a
                      className="text-sm font-medium text-violet-600 hover:underline"
                      href={`/api/system/backups/download?name=${encodeURIComponent(b.name)}`}
                    >
                      Download
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
