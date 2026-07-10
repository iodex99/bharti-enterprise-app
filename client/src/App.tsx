import { useEffect, useState } from 'react';

type Health = { ok: boolean; version: string };

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch('/api/system/health')
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setError(true));
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-violet-50 to-fuchsia-100 p-6">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-xl">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-violet-600 text-3xl text-white">
          B
        </div>
        <h1 className="text-2xl font-bold text-gray-900">Bharti Enterprises</h1>
        <p className="mt-1 text-sm text-gray-500">Production &amp; Inventory Management System</p>
        <div className="mt-6 rounded-lg bg-gray-50 p-4 text-sm">
          {error && <span className="text-red-600">Server not reachable</span>}
          {!error && !health && <span className="text-gray-400">Checking server…</span>}
          {health && (
            <span className="text-emerald-600">
              Server online · v{health.version}
            </span>
          )}
        </div>
        <p className="mt-6 text-xs text-gray-400">System under construction — Phase 0 scaffold</p>
      </div>
    </div>
  );
}
