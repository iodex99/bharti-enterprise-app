import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatTimestampIST } from '@shared';
import { api, ApiError } from '../api/client';
import { Button, ErrorText } from './ui';

type Manifest = {
  appVersion: string;
  createdAt: string;
  counts: { users: number; purchases: number; jobCards: number; uploads: number };
};
type UploadResult = { token: string; manifest: Manifest; compatible: boolean; warning?: string };
type CloudSnapshot = { name: string; sizeBytes: number; modifiedAt: string; manifest: Manifest | null };

/**
 * Restore the whole business from a complete backup — used both on the Backups page and
 * in the first-run setup wizard. Replaces ALL current data, so it always asks for an
 * explicit typed confirmation. On success the server signs everyone out (the user set may
 * differ in the restored data), so we send the browser back to the login screen.
 */
export function RestoreCard({ compact = false }: { compact?: boolean }) {
  const [pending, setPending] = useState<{ manifest: Manifest; source: { token: string } | { cloudName: string }; warning?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmText, setConfirmText] = useState('');

  const candidates = useQuery({
    queryKey: ['restore-candidates'],
    queryFn: () => api.get<{ cloudDir: string | null; items: CloudSnapshot[] }>('/api/system/restore/candidates'),
  });

  const pickFile = async (file: File) => {
    setError('');
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('backup', file);
      const res = await fetch('/api/system/restore/upload', { method: 'POST', body: fd });
      const body = (await res.json()) as UploadResult & { error?: string };
      if (!res.ok) throw new Error(body.error ?? 'Upload failed.');
      setPending({ manifest: body.manifest, source: { token: body.token }, warning: body.compatible ? undefined : body.warning });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setBusy(false);
    }
  };

  const pickCloud = (snap: CloudSnapshot) => {
    setError('');
    if (!snap.manifest) {
      setError('That cloud file could not be read as a backup.');
      return;
    }
    setPending({ manifest: snap.manifest, source: { cloudName: snap.name } });
  };

  const commit = async () => {
    if (!pending) return;
    setBusy(true);
    setError('');
    try {
      await api.post('/api/system/restore/commit', pending.source);
      // sessions were cleared server-side — go re-authenticate against the restored data
      window.location.assign('/login?restored=1');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Restore failed.');
      setBusy(false);
    }
  };

  const cloudItems = candidates.data?.items ?? [];

  return (
    <section className="rounded-2xl border border-amber-300 bg-amber-50/50 p-4">
      <h2 className="mb-1 text-sm font-bold text-gray-900">↩️ Restore / move from another computer</h2>
      <p className="mb-3 text-sm text-gray-600">
        Restore a <strong>complete backup</strong> (the single file that carries the database
        <em> and</em> all photos). This <strong>replaces everything</strong> currently on this
        computer — the current data is copied aside first and put back automatically if anything
        goes wrong.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50">
          {busy ? 'Reading…' : 'Choose a backup file…'}
          <input
            type="file"
            accept=".zip"
            className="hidden"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void pickFile(f);
              e.target.value = '';
            }}
          />
        </label>
        {candidates.data?.cloudDir && (
          <span className="text-xs text-gray-400">or pick one from Google Drive below</span>
        )}
      </div>

      {!compact && cloudItems.length > 0 && (
        <div className="mt-3 overflow-hidden rounded-xl border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <tbody>
              {cloudItems.map((s) => (
                <tr key={s.name} className="border-b border-gray-100 last:border-0">
                  <td className="px-3 py-2 font-mono text-xs text-gray-600">{s.name}</td>
                  <td className="px-3 py-2 text-gray-500">{formatTimestampIST(s.modifiedAt)}</td>
                  <td className="px-3 py-2 text-gray-500">
                    {s.manifest ? `${s.manifest.counts.purchases} purchases · ${s.manifest.counts.uploads} photos` : 'unreadable'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button variant="ghost" className="text-amber-700" disabled={!s.manifest} onClick={() => pickCloud(s)}>
                      Restore this
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ErrorText>{error}</ErrorText>

      {pending && (
        <div className="mt-3 rounded-xl border border-amber-400 bg-white p-3">
          <p className="text-sm font-semibold text-gray-900">You are about to replace ALL current data with:</p>
          <ul className="mt-1 text-sm text-gray-600">
            <li>Created: {formatTimestampIST(pending.manifest.createdAt)} · app {pending.manifest.appVersion}</li>
            <li>
              {pending.manifest.counts.purchases} purchases · {pending.manifest.counts.jobCards} job cards ·{' '}
              {pending.manifest.counts.uploads} photos · {pending.manifest.counts.users} users
            </li>
          </ul>
          {pending.warning && <p className="mt-2 text-sm font-medium text-red-600">{pending.warning}</p>}
          <p className="mt-3 text-sm text-gray-700">
            Type <strong>RESTORE</strong> to confirm. Everyone will be signed out afterwards.
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <input
              className="w-40 rounded-lg border border-gray-300 px-3 py-2 text-sm"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="RESTORE"
              aria-label="Type RESTORE to confirm"
            />
            <Button variant="danger" disabled={busy || confirmText !== 'RESTORE'} onClick={() => void commit()}>
              {busy ? 'Restoring…' : 'Replace all data now'}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => { setPending(null); setConfirmText(''); }}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
