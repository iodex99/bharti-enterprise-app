import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { Badge, Button, ErrorText, Field, Spinner, TextInput } from '../../components/ui';

type Reconciliation = {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
};

type UpdateStatus = {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  supervised: boolean;
  lastCheckedAt: string | null;
};

export default function SystemPage() {
  const queryClient = useQueryClient();
  const { data: recon, isLoading: reconLoading, refetch } = useQuery({
    queryKey: ['system', 'reconciliation'],
    queryFn: () => api.get<Reconciliation>('/api/system/reconciliation'),
  });
  const { data: status } = useQuery({
    queryKey: ['system', 'update-status'],
    queryFn: () => api.get<UpdateStatus>('/api/system/update-status'),
  });
  const { data: settings } = useQuery({
    queryKey: ['system', 'settings'],
    queryFn: () => api.get<{ settings: Record<string, string> }>('/api/system/settings'),
  });

  const [days, setDays] = useState<string | null>(null);
  const [error, setError] = useState('');
  const saveDays = useMutation({
    mutationFn: (value: string) => api.put('/api/system/settings', { key: 'delayed_job_days', value }),
    onSuccess: () => {
      setError('');
      void queryClient.invalidateQueries({ queryKey: ['system', 'settings'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Save failed.'),
  });

  const effectiveDays = days ?? settings?.settings.delayed_job_days ?? '7';

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="text-xl font-bold text-gray-900">System Health</h1>
        <p className="text-sm text-gray-500">
          Version, inventory self-checks and business settings
        </p>
      </div>

      <section className="rounded-2xl border border-gray-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-bold text-gray-900">Version</h2>
        <p className="text-sm text-gray-600">
          Running <span className="font-mono font-semibold">v{status?.current ?? '…'}</span>
          {status?.latest && (
            <>
              {' '}
              · latest release <span className="font-mono">{status.latest}</span>{' '}
              {status.updateAvailable ? (
                <Badge tone="amber">update available — see the banner</Badge>
              ) : (
                <Badge tone="green">up to date</Badge>
              )}
            </>
          )}
          {!status?.supervised && (
            <span className="ml-2 text-xs text-gray-400">(development mode — self-update off)</span>
          )}
        </p>
      </section>

      <section className="rounded-2xl border border-gray-200 bg-white p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-bold text-gray-900">
            Inventory self-check{' '}
            {recon &&
              (recon.ok ? <Badge tone="green">all good</Badge> : <Badge tone="red">attention</Badge>)}
          </h2>
          <Button variant="secondary" onClick={() => void refetch()}>
            Re-run
          </Button>
        </div>
        {reconLoading && <Spinner />}
        <ul className="space-y-2">
          {recon?.checks.map((check) => (
            <li key={check.name} className="flex items-start gap-2 text-sm">
              <span aria-label={check.ok ? 'pass' : 'fail'}>{check.ok ? '✅' : '❌'}</span>
              <span>
                <span className="font-medium text-gray-900">{check.name}.</span>{' '}
                <span className="text-gray-500">{check.detail}</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-gray-400">
          These checks re-derive the stock ledger's conservation rules. If one ever fails,
          take a backup and contact support — do not keep entering data.
        </p>
      </section>

      <DemoCard />

      <section className="rounded-2xl border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-bold text-gray-900">Settings</h2>
        <form
          className="flex max-w-sm items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            saveDays.mutate(effectiveDays);
          }}
        >
          <div className="flex-1">
            <Field label="Job considered delayed after (days)">
              <TextInput
                inputMode="numeric"
                value={effectiveDays}
                onChange={(e) => /^\d{0,3}$/.test(e.target.value) && setDays(e.target.value)}
              />
            </Field>
          </div>
          <Button type="submit" disabled={saveDays.isPending}>
            {saveDays.isPending ? 'Saving…' : 'Save'}
          </Button>
        </form>
        <ErrorText>{error}</ErrorText>
      </section>
    </div>
  );
}

type DemoStatus = { active: boolean; demoExists: boolean };

function DemoCard() {
  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const { data: demo } = useQuery({
    queryKey: ['system', 'demo'],
    queryFn: () => api.get<DemoStatus>('/api/system/demo'),
  });

  const finishSwitch = () => {
    // The session, and every cached query, belong to the database we just switched away
    // from — so this is one full page load, not a router navigation followed by a reload.
    // (Doing both fired two navigations to /login, which raced each other.) `replace`
    // keeps an admin page for a dead session out of the back history.
    window.location.replace('/login');
  };

  const enter = useMutation({
    mutationFn: (fresh: boolean) => api.post(`/api/system/demo/enter${fresh ? '?fresh=1' : ''}`),
    onSuccess: finishSwitch,
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not start demo mode.'),
  });
  const exit = useMutation({
    mutationFn: () => api.post('/api/system/demo/exit'),
    onSuccess: finishSwitch,
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not exit demo mode.'),
  });
  const remove = useMutation({
    mutationFn: () => api.post('/api/system/demo/remove'),
    onSuccess: () => {
      setError('');
      void queryClient.invalidateQueries({ queryKey: ['system', 'demo'] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not remove demo data.'),
  });

  const busy = enter.isPending || exit.isPending || remove.isPending;

  return (
    <section className="rounded-2xl border border-amber-200 bg-amber-50/50 p-4">
      <h2 className="mb-1 text-sm font-bold text-gray-900">
        🎭 Demo mode{' '}
        {demo?.active ? <Badge tone="amber">ACTIVE — sample data</Badge> : <Badge tone="gray">off</Badge>}
      </h2>
      <p className="mb-3 text-sm text-gray-600">
        Runs the app on a completely separate sample database (~3 months of realistic
        business) for giving demos. Real records are never read or touched. Switching
        signs everyone out — demo sign-in is <code>admin / Admin@123</code>.
      </p>
      <div className="flex flex-wrap gap-2">
        {!demo?.active && (
          <>
            <Button
              disabled={busy}
              onClick={() => {
                if (confirm('Start demo mode? You will be signed out and can sign in with admin / Admin@123.')) {
                  enter.mutate(false);
                }
              }}
            >
              {enter.isPending ? 'Preparing demo…' : demo?.demoExists ? 'Enter demo mode' : 'Create & enter demo mode'}
            </Button>
            {demo?.demoExists && (
              <>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    if (confirm('Rebuild the demo data from scratch and enter demo mode?')) {
                      enter.mutate(true);
                    }
                  }}
                >
                  Rebuild fresh & enter
                </Button>
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() => {
                    if (confirm('Delete the demo database entirely? Real data is unaffected.')) {
                      remove.mutate();
                    }
                  }}
                >
                  {remove.isPending ? 'Removing…' : 'Remove demo data'}
                </Button>
              </>
            )}
          </>
        )}
        {demo?.active && (
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              if (confirm('Exit demo mode and return to real data? You will sign back in with your usual account.')) {
                exit.mutate();
              }
            }}
          >
            {exit.isPending ? 'Switching back…' : 'Exit demo mode (back to real data)'}
          </Button>
        )}
      </div>
      <ErrorText>{error}</ErrorText>
    </section>
  );
}
