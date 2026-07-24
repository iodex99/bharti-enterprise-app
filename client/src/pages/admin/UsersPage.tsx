import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { useAuth } from '../../lib/auth';
import { Badge, Button, ErrorText, Field, Modal, Select, Spinner, TextInput } from '../../components/ui';

type UserRow = {
  id: number;
  username: string;
  displayName: string;
  role: 'admin' | 'operator' | 'owner';
  officeId: number | null;
  officeName: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
  createdAt: string;
};

function OfficePicker({ value, onChange }: { value: number | null; onChange: (id: number | null) => void }) {
  const { data } = useQuery({
    queryKey: ['offices'],
    queryFn: () => api.get<{ items: Array<{ id: number; name: string }> }>('/api/offices'),
    staleTime: 60_000,
  });
  return (
    <Select value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="" disabled>
        — office —
      </option>
      {data?.items.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </Select>
  );
}

const ROLE_TONE = { admin: 'violet', operator: 'blue', owner: 'green' } as const;

export default function UsersPage() {
  const queryClient = useQueryClient();
  const { user: me } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<{ users: UserRow[] }>('/api/users'),
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [resetFor, setResetFor] = useState<UserRow | null>(null);
  const [editFor, setEditFor] = useState<UserRow | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['users'] });

  const toggle = useMutation({
    mutationFn: (u: UserRow) =>
      api.post(`/api/users/${u.id}/${u.isActive ? 'deactivate' : 'reactivate'}`),
    onSettled: invalidate,
  });

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Users</h1>
          <p className="text-sm text-gray-500">Sign-in accounts and roles</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>+ New user</Button>
      </div>

      {isLoading && <Spinner />}
      {data && (
        <div className="overflow-x-auto rounded-2xl border border-gray-200 bg-white">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-400">
                <th className="px-4 py-3">User</th>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.id} className="border-b border-gray-100 last:border-0">
                  <td className="px-4 py-3">
                    <p className="font-medium text-gray-900">{u.displayName}</p>
                    <p className="text-xs text-gray-400">@{u.username}</p>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={ROLE_TONE[u.role]}>{u.role}</Badge>
                    {u.officeName && <Badge tone="gray">🏢 {u.officeName}</Badge>}
                  </td>
                  <td className="px-4 py-3">
                    {u.isActive ? (
                      <Badge tone="green">active</Badge>
                    ) : (
                      <Badge tone="red">deactivated</Badge>
                    )}
                    {u.mustChangePassword && (
                      <Badge tone="amber">must change password</Badge>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" onClick={() => setEditFor(u)}>
                        Edit
                      </Button>
                      <Button variant="ghost" onClick={() => setResetFor(u)}>
                        Reset password
                      </Button>
                      {u.id !== me?.id && (
                        <Button
                          variant="ghost"
                          className={u.isActive ? 'text-red-600' : 'text-emerald-600'}
                          onClick={() => toggle.mutate(u)}
                        >
                          {u.isActive ? 'Deactivate' : 'Reactivate'}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CreateUserModal open={createOpen} onClose={() => setCreateOpen(false)} onDone={invalidate} />
      <EditUserModal user={editFor} onClose={() => setEditFor(null)} onDone={invalidate} />
      <ResetPasswordModal user={resetFor} onClose={() => setResetFor(null)} />
    </div>
  );
}

function CreateUserModal({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState('operator');
  const [officeId, setOfficeId] = useState<number | null>(1);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api.post('/api/users', {
        username,
        displayName,
        role,
        officeId: role === 'operator' ? officeId : null,
        password,
      }),
    onSuccess: () => {
      onDone();
      onClose();
      setUsername('');
      setDisplayName('');
      setPassword('');
      setError('');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Failed to create user.'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <Modal title="New user" open={open} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Username" hint="Used to sign in; letters/numbers only">
          <TextInput value={username} onChange={(e) => setUsername(e.target.value)} required autoCapitalize="none" />
        </Field>
        <Field label="Full name">
          <TextInput value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
        </Field>
        <Field label="Role">
          <Select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="operator">Operator — data entry</option>
            <option value="owner">Owner — read-only reports</option>
            <option value="admin">Admin — full control</option>
          </Select>
        </Field>
        {role === 'operator' && (
          <Field label="Office" hint="Operators work in exactly one office">
            <OfficePicker value={officeId} onChange={setOfficeId} />
          </Field>
        )}
        <Field label="Temporary password" hint="They must change it at first sign-in (min 8 chars)">
          <TextInput value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
        </Field>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" disabled={create.isPending} className="w-full">
          {create.isPending ? 'Creating…' : 'Create user'}
        </Button>
      </form>
    </Modal>
  );
}

function EditUserModal({
  user,
  onClose,
  onDone,
}: {
  user: UserRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState('operator');
  const [officeId, setOfficeId] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [loadedFor, setLoadedFor] = useState<number | null>(null);

  if (user && loadedFor !== user.id) {
    setDisplayName(user.displayName);
    setRole(user.role);
    setOfficeId(user.officeId ?? 1);
    setLoadedFor(user.id);
    setError('');
  }

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/api/users/${user!.id}`, {
        displayName,
        role,
        officeId: role === 'operator' ? officeId : null,
      }),
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Failed to save.'),
  });

  return (
    <Modal title={`Edit ${user?.username ?? ''}`} open={!!user} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="space-y-4"
      >
        <Field label="Full name">
          <TextInput value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
        </Field>
        <Field label="Role">
          <Select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="operator">Operator</option>
            <option value="owner">Owner</option>
            <option value="admin">Admin</option>
          </Select>
        </Field>
        {role === 'operator' && (
          <Field label="Office">
            <OfficePicker value={officeId} onChange={setOfficeId} />
          </Field>
        )}
        <ErrorText>{error}</ErrorText>
        <Button type="submit" disabled={save.isPending} className="w-full">
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </form>
    </Modal>
  );
}

function ResetPasswordModal({ user, onClose }: { user: UserRow | null; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const reset = useMutation({
    mutationFn: () => api.post(`/api/users/${user!.id}/reset-password`, { password }),
    onSuccess: () => setDone(true),
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Failed to reset.'),
  });

  const close = () => {
    setPassword('');
    setError('');
    setDone(false);
    onClose();
  };

  return (
    <Modal title={`Reset password — ${user?.username ?? ''}`} open={!!user} onClose={close}>
      {done ? (
        <div className="space-y-4">
          <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            Password reset. Share the temporary password with {user?.displayName}; they must
            change it at first sign-in.
          </p>
          <Button onClick={close} className="w-full">
            Done
          </Button>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            reset.mutate();
          }}
          className="space-y-4"
        >
          <Field label="Temporary password" hint="Min 8 characters">
            <TextInput value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
          </Field>
          <ErrorText>{error}</ErrorText>
          <Button type="submit" disabled={reset.isPending} className="w-full">
            {reset.isPending ? 'Resetting…' : 'Reset password'}
          </Button>
        </form>
      )}
    </Modal>
  );
}
