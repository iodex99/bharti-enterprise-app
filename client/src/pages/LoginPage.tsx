import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { api, ApiError } from '../api/client';
import { useAuth } from '../lib/auth';
import { useHealth } from '../api/health';
import { readInitialAdmin } from '../local/first-run';
import { Button, ErrorText, Field, TextInput } from '../components/ui';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { refresh } = useAuth();
  const { data: health } = useHealth();
  const navigate = useNavigate();
  // Only ever set on a device the app set itself up on, and cleared once the password
  // has been changed.
  const [firstRun] = useState(readInitialAdmin);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/api/auth/login', { username, password });
      await refresh();
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-violet-50 to-fuchsia-100 p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-violet-600 text-2xl font-bold text-white">
            B
          </div>
          <h1 className="text-xl font-bold text-gray-900">Bharti Enterprises</h1>
          <p className="text-sm text-gray-500">Production &amp; Inventory System</p>
        </div>
        {health?.demoMode && (
          <p className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-center text-sm text-amber-900">
            🎭 <strong>Demo mode</strong> — sign in with <code>admin</code> /{' '}
            <code>Admin@123</code>
          </p>
        )}
        {firstRun && (
          <div className="mb-4 rounded-xl border border-violet-300 bg-violet-50 px-3 py-3 text-sm text-violet-900">
            <p className="font-semibold">👋 This device is new — here is your sign-in.</p>
            <p className="mt-2">
              Username <code className="rounded bg-white px-1 py-0.5 font-mono">{firstRun.username}</code>
              <br />
              Password{' '}
              <code className="rounded bg-white px-1 py-0.5 font-mono text-base tracking-wider">
                {firstRun.password}
              </code>
            </p>
            <p className="mt-2 text-xs">
              Write it down. You will be asked to set your own password straight away, and
              this message will disappear once you have.
            </p>
          </div>
        )}
        {typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('restored') && (
          <p className="mb-4 rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-center text-sm text-emerald-900">
            ✅ <strong>Data restored.</strong> Sign in with an account from the restored data.
          </p>
        )}
        <form onSubmit={submit} className="space-y-4 rounded-2xl bg-white p-6 shadow-xl">
          <Field label="Username">
            <TextInput
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              required
              autoFocus
            />
          </Field>
          <Field label="Password">
            <TextInput
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>
          <ErrorText>{error}</ErrorText>
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </div>
    </div>
  );
}
