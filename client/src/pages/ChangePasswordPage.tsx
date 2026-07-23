import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { api, ApiError } from '../api/client';
import { useAuth } from '../lib/auth';
import { clearInitialAdmin } from '../local/first-run';
import { Button, ErrorText, Field, TextInput } from '../components/ui';

export default function ChangePasswordPage({ forced = false }: { forced?: boolean }) {
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { refresh } = useAuth();
  const navigate = useNavigate();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirm) {
      setError('New passwords do not match.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.post('/api/auth/change-password', { currentPassword, newPassword });
      // The generated first-run password is now worthless — stop showing it on sign-in.
      clearInitialAdmin();
      await refresh();
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-md p-4 sm:p-6">
      <h1 className="mb-1 text-xl font-bold text-gray-900">Change password</h1>
      {forced && (
        <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          You must set a new password before continuing.
        </p>
      )}
      <form onSubmit={submit} className="space-y-4 rounded-2xl bg-white p-5 shadow">
        <Field label="Current password">
          <TextInput
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>
        <Field label="New password" hint="At least 8 characters with letters and numbers">
          <TextInput
            type="password"
            value={newPassword}
            onChange={(e) => setNew(e.target.value)}
            autoComplete="new-password"
            required
          />
        </Field>
        <Field label="Confirm new password">
          <TextInput
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
          />
        </Field>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? 'Saving…' : 'Save new password'}
        </Button>
      </form>
    </div>
  );
}
