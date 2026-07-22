import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { ErrorText } from '../components/ui';
import { RestoreCard } from '../components/RestoreCard';

/**
 * First-run wizard shown only on a brand-new install (no business data yet). One question:
 * start a new business, or move data over from the old computer.
 */
export default function SetupPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'choose' | 'restore'>('choose');
  const [error, setError] = useState('');

  const startFresh = useMutation({
    mutationFn: () => api.post('/api/system/setup/complete'),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['setup-state'] });
      navigate('/');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not continue.'),
  });

  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center p-4">
      <div className="mb-6 text-center">
        <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-violet-600 text-2xl font-bold text-white">
          B
        </div>
        <h1 className="text-2xl font-bold text-gray-900">Set up this computer</h1>
        <p className="mt-1 text-sm text-gray-500">
          Is this a brand-new business, or are you moving from another computer?
        </p>
      </div>

      {mode === 'choose' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <button
            className="rounded-2xl border border-gray-200 bg-white p-5 text-left transition-colors hover:border-violet-300 disabled:opacity-50"
            disabled={startFresh.isPending}
            onClick={() => startFresh.mutate()}
          >
            <div className="text-2xl">🌱</div>
            <div className="mt-2 font-semibold text-gray-900">Start fresh</div>
            <p className="mt-1 text-sm text-gray-500">
              A new, empty system. You'll add your masters and opening balances.
            </p>
          </button>
          <button
            className="rounded-2xl border border-gray-200 bg-white p-5 text-left transition-colors hover:border-amber-300"
            onClick={() => setMode('restore')}
          >
            <div className="text-2xl">📦</div>
            <div className="mt-2 font-semibold text-gray-900">Move from another computer</div>
            <p className="mt-1 text-sm text-gray-500">
              Restore a complete backup taken from the old computer (or Google Drive).
            </p>
          </button>
        </div>
      ) : (
        <div>
          <RestoreCard />
          <button className="mt-3 text-sm font-medium text-violet-600 hover:underline" onClick={() => setMode('choose')}>
            ← Back
          </button>
        </div>
      )}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
