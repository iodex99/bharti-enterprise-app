import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { formatBusinessDate, formatTimestampIST } from '@shared';
import { Button, EmptyState, ErrorText, Field, Spinner, TextInput } from '../../components/ui';

type BackupInfo = { name: string; sizeBytes: number; modifiedAt: string };

export default function BackupsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['backups'],
    queryFn: () =>
      api.get<{ backups: BackupInfo[]; cloudDir: string | null; lastDailyBackupDate: string | null }>(
        '/api/system/backups',
      ),
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
            Daily at 1:00 PM automatically — and if the computer was off or the backup
            failed, it catches up on its own (hourly and at start-up) until today's backup
            exists. Also before every update, and on demand.
            {data?.lastDailyBackupDate && (
              <span className="ml-1 font-medium text-emerald-700">
                Last daily backup: {formatBusinessDate(data.lastDailyBackupDate)}
              </span>
            )}
          </p>
        </div>
        <Button onClick={() => backupNow.mutate()} disabled={backupNow.isPending}>
          {backupNow.isPending ? 'Backing up…' : 'Backup now'}
        </Button>
      </div>

      <CloudBackupCard currentDir={data?.cloudDir ?? null} />

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

function CloudBackupCard({ currentDir }: { currentDir: string | null }) {
  const queryClient = useQueryClient();
  const [dir, setDir] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [syncNote, setSyncNote] = useState('');
  const effectiveDir = dir ?? currentDir ?? '';

  const save = useMutation({
    mutationFn: (value: string) => api.put('/api/system/settings', { key: 'cloud_backup_dir', value }),
    onSuccess: () => {
      setError('');
      setSyncNote('Folder saved. New backups will be copied there automatically.');
      void queryClient.invalidateQueries({ queryKey: ['backups'] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not save.'),
  });

  const syncNow = useMutation({
    mutationFn: () => api.post<{ copied: number; total: number; dir: string }>('/api/system/backups/sync'),
    onSuccess: (r) => {
      setError('');
      setSyncNote(`Copied ${r.copied} new file(s) — ${r.total} backups now in the cloud folder.`);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Sync failed.'),
  });

  return (
    <section className="mb-5 rounded-2xl border border-sky-200 bg-sky-50/50 p-4">
      <h2 className="mb-1 text-sm font-bold text-gray-900">☁️ Cloud backup (Google Drive)</h2>
      <p className="mb-3 text-sm text-gray-600">
        Install <strong>Google Drive for Desktop</strong> on this computer and sign in with
        the owner's Google account (that sign-in is the only permission Google needs).
        Create a folder inside “My Drive”, paste its path below, and every backup is
        copied there automatically — Drive then uploads it to the owner's account.
        OneDrive or Dropbox folders work the same way.
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(effectiveDir.trim());
        }}
      >
        <div className="min-w-[20rem] flex-1">
          <Field label="Synced folder path (empty = off)">
            <TextInput
              value={effectiveDir}
              placeholder="e.g. G:\My Drive\BhartiBackups"
              onChange={(e) => setDir(e.target.value)}
            />
          </Field>
        </div>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save folder'}
        </Button>
        {currentDir && (
          <Button type="button" variant="secondary" disabled={syncNow.isPending} onClick={() => syncNow.mutate()}>
            {syncNow.isPending ? 'Copying…' : 'Copy all backups now'}
          </Button>
        )}
      </form>
      {syncNote && <p className="mt-2 text-sm text-emerald-700">{syncNote}</p>}
      <ErrorText>{error}</ErrorText>
    </section>
  );
}
