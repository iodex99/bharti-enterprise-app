import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

type UpdateStatus = {
  state: string;
  detail?: string;
  toVersion?: string;
  current: string;
  supervised: boolean;
  latest: string | null;
  updateAvailable: boolean;
  notes: string;
  /**
   * App builds only. 'bundle' updates install on tap; 'apk' means the app file itself
   * changed, and Android requires the user to confirm that install.
   */
  kind?: 'bundle' | 'apk' | null;
  rolledBackFrom?: string;
};

const POLL_CHECK_MS = 15 * 60 * 1000; // periodic "is there an update" check
const POLL_ACTIVE_MS = 2000; // fast polling while an update runs

/**
 * Shows an "Update available" banner for everyone and drives the one-click update
 * (button is admin-gated once auth lands). Survives the server restart by polling
 * until the new version answers, then reloads to pick up new client assets.
 */
export function UpdateBanner({ canUpdate = true }: { canUpdate?: boolean }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [updating, setUpdating] = useState(false);
  const [result, setResult] = useState<'success' | 'rolled_back' | 'failed' | null>(null);
  const startedFrom = useRef<string | null>(null);

  const refresh = useCallback(async (path: string) => {
    try {
      const res = await fetch(`/api/system/${path}`);
      if (!res.ok) return null;
      const body = (await res.json()) as UpdateStatus;
      setStatus(body);
      return body;
    } catch {
      return null; // server restarting — keep polling
    }
  }, []);

  // Periodic update check (external system poll; first check deferred a tick).
  useEffect(() => {
    const t0 = setTimeout(() => void refresh('update-check'), 0);
    const t = setInterval(() => void refresh('update-check'), POLL_CHECK_MS);
    return () => {
      clearTimeout(t0);
      clearInterval(t);
    };
  }, [refresh]);

  // Fast polling while updating; detect completion across the restart.
  useEffect(() => {
    if (!updating) return;
    const t = setInterval(async () => {
      const body = await refresh('update-status');
      if (!body) return;
      if (body.state === 'rolled_back' || body.state === 'failed') {
        setResult(body.state);
        setUpdating(false);
      } else if (
        body.state === 'success' ||
        (startedFrom.current && body.current !== startedFrom.current)
      ) {
        setResult('success');
        setUpdating(false);
        setTimeout(() => window.location.reload(), 1500);
      }
    }, POLL_ACTIVE_MS);
    return () => clearInterval(t);
  }, [updating, refresh]);

  const begin = async () => {
    if (!status) return;
    startedFrom.current = status.current;
    setResult(null);
    setUpdating(true);
    try {
      const res = await fetch('/api/system/update', { method: 'POST' });
      if (!res.ok && res.status !== 409) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setResult('failed');
        setUpdating(false);
        setStatus((s) => (s ? { ...s, detail: body?.error } : s));
      }
    } catch {
      /* server may already be restarting; polling will resolve it */
    }
  };

  if (updating) {
    return (
      <Banner tone="progress">
        <Spinner />
        Updating to {status?.latest ?? 'new version'}… the app will restart itself. Please wait,
        do not close this page.
      </Banner>
    );
  }

  if (result === 'success') {
    return <Banner tone="success">Updated successfully. Reloading…</Banner>;
  }

  if (result === 'rolled_back') {
    return (
      <Banner tone="error">
        The update failed and the previous version was restored automatically. No data was lost.
        {status?.detail ? ` (${status.detail})` : ''}
      </Banner>
    );
  }

  if (result === 'failed') {
    return (
      <Banner tone="error">
        Update could not start{status?.detail ? `: ${status.detail}` : ''}. You can try again
        later.
        <button className="ml-3 underline" onClick={() => setResult(null)}>
          Dismiss
        </button>
      </Banner>
    );
  }

  // A bundle that failed to start was put back automatically. The notice stays until
  // someone acknowledges it — whoever tapped Update may not be who opens the app next.
  if (status?.rolledBackFrom) {
    return (
      <Banner tone="error">
        Version {status.rolledBackFrom} would not start, so the previous version was restored
        automatically. Your data was not affected.
        <button
          className="ml-3 underline"
          onClick={() => {
            setStatus((s) => (s ? { ...s, rolledBackFrom: undefined } : s));
            void fetch('/api/system/update-rollback-notice', { method: 'DELETE' });
          }}
        >
          Dismiss
        </button>
      </Banner>
    );
  }

  if (status?.updateAvailable) {
    return (
      <Banner tone="info">
        <span>
          New version <strong>{status.latest}</strong> available (you have v{status.current}).
        </span>
        {canUpdate && status.kind === 'apk' && (
          <button
            onClick={() => void fetch('/api/system/update-apk', { method: 'POST' })}
            className="ml-3 rounded-md bg-violet-600 px-3 py-1 text-sm font-semibold text-white hover:bg-violet-700"
          >
            Download app file
          </button>
        )}
        {canUpdate && status.kind === 'apk' && (
          <span className="ml-2 text-xs opacity-70">
            (this one replaces the app itself — open the downloaded file to install; your data
            stays on the device)
          </span>
        )}
        {canUpdate && status.kind !== 'apk' && status.supervised && (
          <button
            onClick={() => void begin()}
            className="ml-3 rounded-md bg-violet-600 px-3 py-1 text-sm font-semibold text-white hover:bg-violet-700"
          >
            Update now
          </button>
        )}
        {!status.supervised && (
          <span className="ml-2 text-xs opacity-70">(auto-update available on the office server)</span>
        )}
      </Banner>
    );
  }

  return null;
}

function Banner({
  tone,
  children,
}: {
  tone: 'info' | 'progress' | 'success' | 'error';
  children: ReactNode;
}) {
  const tones: Record<string, string> = {
    info: 'bg-violet-50 text-violet-900 border-violet-200',
    progress: 'bg-amber-50 text-amber-900 border-amber-200',
    success: 'bg-emerald-50 text-emerald-900 border-emerald-200',
    error: 'bg-red-50 text-red-900 border-red-200',
  };
  return (
    <div
      role="status"
      className={`flex flex-wrap items-center justify-center gap-1 border-b px-4 py-2 text-sm ${tones[tone]}`}
    >
      {children}
    </div>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}
