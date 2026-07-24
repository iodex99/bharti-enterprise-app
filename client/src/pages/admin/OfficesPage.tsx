import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { activeOfficeId, api, ApiError, switchOffice } from '../../api/client';
import { DataTable } from '../../components/DataTable';
import { Badge, Button, ErrorText, Field, Modal, TextInput } from '../../components/ui';

type OfficeRow = { id: number; code: string; name: string; isActive: number };

/**
 * Offices (ADR-028): each office's documents, stock and numbering are separate; masters
 * and logins are shared. The admin configures offices here and assigns operators to one
 * on the Users page.
 */
export default function OfficesPage() {
  const queryClient = useQueryClient();
  const [modalFor, setModalFor] = useState<OfficeRow | 'new' | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['offices', 'all'],
    queryFn: () => api.get<{ items: OfficeRow[] }>('/api/offices?includeInactive=1'),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['offices'] });
  };

  const rows = data?.items;

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Offices</h1>
          <p className="text-sm text-gray-500">
            Each office keeps its own documents, stock and numbering. Operators belong to
            one office; you and the owner can switch between them from the top bar.
          </p>
        </div>
        <Button onClick={() => setModalFor('new')}>+ New office</Button>
      </div>

      <DataTable
        columns={[
          {
            key: 'code',
            header: 'Code',
            className: 'font-mono font-medium',
            render: (r) => (
              <span>
                {r.code}
                {r.id === 1 && <span className="ml-1 text-xs text-gray-400">(first office — plain numbering)</span>}
              </span>
            ),
          },
          { key: 'name', header: 'Name', className: 'font-medium' },
          {
            key: 'numbering',
            header: 'Document numbers',
            render: (r) => (
              <span className="font-mono text-xs text-gray-500">
                {r.id === 1 ? 'RM-0001, JOB-0001, …' : `${r.code}-RM-0001, ${r.code}-JOB-0001, …`}
              </span>
            ),
          },
          {
            key: 'isActive',
            header: 'Status',
            render: (r) =>
              r.isActive ? (
                r.id === activeOfficeId() ? (
                  <Badge tone="violet">you are here</Badge>
                ) : (
                  <Badge tone="green">active</Badge>
                )
              ) : (
                <Badge tone="gray">deactivated</Badge>
              ),
          },
        ]}
        rows={rows}
        loading={isLoading}
        emptyTitle="No offices"
        actions={(row) => (
          <>
            {row.isActive === 1 && row.id !== activeOfficeId() && (
              <Button variant="ghost" className="text-violet-700" onClick={() => switchOffice(row.id)}>
                Work here
              </Button>
            )}
            <Button variant="ghost" onClick={() => setModalFor(row)}>
              Edit
            </Button>
          </>
        )}
      />

      {modalFor && (
        <OfficeModal
          key={modalFor === 'new' ? 'new' : modalFor.id}
          office={modalFor === 'new' ? null : modalFor}
          onClose={() => setModalFor(null)}
          onDone={invalidate}
        />
      )}
    </div>
  );
}

function OfficeModal({
  office,
  onClose,
  onDone,
}: {
  office: OfficeRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [code, setCode] = useState(office?.code ?? '');
  const [name, setName] = useState(office?.name ?? '');
  const [isActive, setIsActive] = useState(office ? !!office.isActive : true);
  const [error, setError] = useState('');

  const save = useMutation({
    mutationFn: () =>
      office
        ? api.put(`/api/offices/${office.id}`, { code: code.toUpperCase(), name, isActive })
        : api.post('/api/offices', { code: code.toUpperCase(), name }),
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Save failed.'),
  });

  return (
    <Modal title={office ? `Edit ${office.name}` : 'New office'} open onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="space-y-4"
      >
        <Field label="Short code" hint="Goes into that office's document numbers, e.g. BR → BR-RM-0001">
          <TextInput
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="e.g. BR"
            required
            minLength={2}
            maxLength={6}
            disabled={office?.id === 1}
          />
        </Field>
        <Field label="Office name">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Branch Office" required />
        </Field>
        {office && office.id !== 1 && (
          <label className="flex items-center gap-2 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="rounded border-gray-300"
            />
            Active (deactivating hides it from switching and blocks its operators)
          </label>
        )}
        <ErrorText>{error}</ErrorText>
        <Button type="submit" disabled={save.isPending} className="w-full">
          {save.isPending ? 'Saving…' : office ? 'Save changes' : 'Create office'}
        </Button>
      </form>
    </Modal>
  );
}
