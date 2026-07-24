import { useState } from 'react';
import { useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm, Controller, type FieldValues, type Path, type PathValue } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { ZodType } from 'zod';
import {
  colorSchema,
  contractorSchema,
  formatPaise,
  sizeSchema,
  staffSchema,
  vendorSchema,
} from '@shared';
import { api, ApiError } from '../../api/client';
import { useAuth } from '../../lib/auth';
import { DataTable, type Column } from '../../components/DataTable';
import { Badge, Button, ErrorText, Field, Modal, Select, TextInput } from '../../components/ui';
import { ImageInput, MoneyInput } from '../../components/inputs';

type BaseRow = { id: number; isActive: boolean; createdAt: string } & Record<string, unknown>;

type FieldDef =
  | { kind: 'text'; name: string; label: string; hint?: string; required?: boolean }
  | { kind: 'textarea'; name: string; label: string }
  | { kind: 'number'; name: string; label: string; hint?: string }
  | { kind: 'money'; name: string; label: string; hint?: string }
  | { kind: 'image'; name: string; label: string }
  | { kind: 'select'; name: string; label: string; options: Array<{ value: string; label: string }> };

type MasterDef = {
  title: string;
  singular: string;
  schema: ZodType;
  columns: Column<BaseRow>[];
  fields: FieldDef[];
  empty: Record<string, unknown>;
};

const DEFS: Record<string, MasterDef> = {
  // models are NOT a master (ADR-030): codes are typed at cutting
  colors: {
    title: 'Colors',
    singular: 'color',
    schema: colorSchema,
    columns: [
      {
        key: 'swatch',
        header: '',
        className: 'w-10',
        render: (r) =>
          r.colorCode ? (
            <span
              className="inline-block h-6 w-6 rounded-full border border-gray-200"
              style={{ backgroundColor: String(r.colorCode) }}
            />
          ) : null,
      },
      { key: 'name', header: 'Color', className: 'font-medium' },
      { key: 'colorCode', header: 'Code', className: 'text-gray-500 font-mono text-xs' },
    ],
    fields: [
      { kind: 'text', name: 'name', label: 'Color name', required: true },
      { kind: 'text', name: 'colorCode', label: 'Color code (optional)', hint: '#RRGGBB, e.g. #800000' },
    ],
    empty: { name: '', colorCode: '' },
  },
  sizes: {
    title: 'Sizes',
    singular: 'size',
    schema: sizeSchema,
    columns: [
      { key: 'code', header: 'Size code', className: 'font-medium' },
      { key: 'description', header: 'Description', className: 'text-gray-500' },
      { key: 'sortOrder', header: 'Order', className: 'w-20 text-gray-400' },
    ],
    fields: [
      { kind: 'text', name: 'code', label: 'Size code', hint: 'e.g. XS, S1, L1', required: true },
      { kind: 'text', name: 'description', label: 'Description' },
      { kind: 'number', name: 'sortOrder', label: 'Sort order', hint: 'Lower shows first' },
    ],
    empty: { code: '', description: '', sortOrder: 0 },
  },
  vendors: {
    title: 'Vendors',
    singular: 'vendor',
    schema: vendorSchema,
    columns: [
      { key: 'name', header: 'Vendor', className: 'font-medium' },
      { key: 'contactPerson', header: 'Contact' },
      { key: 'mobile', header: 'Mobile' },
      { key: 'gstin', header: 'GSTIN', className: 'font-mono text-xs text-gray-500' },
    ],
    fields: [
      { kind: 'text', name: 'name', label: 'Vendor name', required: true },
      { kind: 'text', name: 'contactPerson', label: 'Contact person' },
      { kind: 'text', name: 'mobile', label: 'Mobile number' },
      { kind: 'textarea', name: 'address', label: 'Address' },
      { kind: 'text', name: 'gstin', label: 'GST number', hint: '15 characters' },
      { kind: 'textarea', name: 'notes', label: 'Notes' },
    ],
    empty: { name: '', contactPerson: '', mobile: '', address: '', gstin: '', notes: '' },
  },
  contractors: {
    title: 'Contractors',
    singular: 'contractor',
    schema: contractorSchema,
    columns: [
      { key: 'name', header: 'Contractor', className: 'font-medium' },
      { key: 'contactPerson', header: 'Contact' },
      { key: 'mobile', header: 'Mobile' },
      {
        key: 'defaultRatePaisePerDozen',
        header: 'Rate / dozen',
        render: (r) => formatPaise(Number(r.defaultRatePaisePerDozen ?? 0)),
      },
    ],
    fields: [
      { kind: 'text', name: 'name', label: 'Contractor name', required: true },
      { kind: 'text', name: 'contactPerson', label: 'Contact person' },
      { kind: 'text', name: 'mobile', label: 'Mobile number' },
      { kind: 'textarea', name: 'address', label: 'Address' },
      { kind: 'money', name: 'defaultRatePaisePerDozen', label: 'Default rate per dozen' },
      { kind: 'textarea', name: 'notes', label: 'Notes' },
    ],
    empty: { name: '', contactPerson: '', mobile: '', address: '', defaultRatePaisePerDozen: 0, notes: '' },
  },
  staff: {
    title: 'Checkers & Packers',
    singular: 'staff member',
    schema: staffSchema,
    // no fixed role — any staff member can be picked as checker OR packer
    columns: [
      { key: 'name', header: 'Name', className: 'font-medium' },
      { key: 'mobile', header: 'Mobile' },
      { key: 'notes', header: 'Notes', className: 'text-gray-500' },
    ],
    fields: [
      { kind: 'text', name: 'name', label: 'Name', required: true },
      { kind: 'text', name: 'mobile', label: 'Mobile number' },
      { kind: 'textarea', name: 'notes', label: 'Notes' },
    ],
    empty: { name: '', mobile: '', notes: '' },
  },
};

export default function MastersPage() {
  const { master = '' } = useParams();
  const def = DEFS[master];
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const queryClient = useQueryClient();
  const [showInactive, setShowInactive] = useState(false);
  const [editRow, setEditRow] = useState<BaseRow | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [actionError, setActionError] = useState('');

  const queryKey = ['masters', master, showInactive];
  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: () =>
      api.get<{ items: BaseRow[] }>(
        `/api/masters/${master}${showInactive ? '?includeInactive=1' : ''}`,
      ),
    enabled: !!def,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['masters', master] });

  const act = useMutation({
    mutationFn: ({ id, action }: { id: number; action: string }) =>
      action === 'delete'
        ? api.delete(`/api/masters/${master}/${id}`)
        : api.post(`/api/masters/${master}/${id}/${action}`),
    onSuccess: () => {
      setActionError('');
      invalidate();
    },
    onError: (err) => setActionError(err instanceof ApiError ? err.message : 'Action failed.'),
  });

  if (!def) {
    return <div className="p-6 text-sm text-gray-500">Unknown master “{master}”.</div>;
  }

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold text-gray-900">{def.title}</h1>
          <p className="text-sm text-gray-500">Master data</p>
        </div>
        {isAdmin && <Button onClick={() => setCreateOpen(true)}>+ New {def.singular}</Button>}
      </div>

      {actionError && (
        <div className="mb-3">
          <ErrorText>{actionError}</ErrorText>
        </div>
      )}

      <DataTable
        columns={[
          ...def.columns,
          {
            key: 'isActive',
            header: 'Status',
            render: (r) =>
              r.isActive ? <Badge tone="green">active</Badge> : <Badge tone="red">inactive</Badge>,
          },
        ]}
        rows={data?.items}
        loading={isLoading}
        emptyTitle={`No ${def.title.toLowerCase()} yet`}
        emptyHint={isAdmin ? `Press “+ New ${def.singular}” to add the first one.` : undefined}
        toolbar={
          <label className="flex items-center gap-1.5 text-sm text-gray-500">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="rounded border-gray-300"
            />
            Show inactive
          </label>
        }
        actions={
          isAdmin
            ? (row) => (
                <>
                  <Button variant="ghost" onClick={() => setEditRow(row)}>
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    className={row.isActive ? 'text-amber-600' : 'text-emerald-600'}
                    onClick={() => act.mutate({ id: row.id, action: row.isActive ? 'deactivate' : 'reactivate' })}
                  >
                    {row.isActive ? 'Deactivate' : 'Reactivate'}
                  </Button>
                  <Button
                    variant="ghost"
                    className="text-red-600"
                    onClick={() => {
                      if (confirm(`Delete this ${def.singular}? Only possible when never used.`)) {
                        act.mutate({ id: row.id, action: 'delete' });
                      }
                    }}
                  >
                    Delete
                  </Button>
                </>
              )
            : undefined
        }
      />

      {/* key= remounts the form (and its once-initialized inputs) per record/open */}
      <MasterForm
        key={`create-${createOpen}`}
        def={def}
        master={master}
        open={createOpen}
        row={null}
        onClose={() => setCreateOpen(false)}
        onDone={invalidate}
      />
      <MasterForm
        key={`edit-${editRow?.id ?? 'none'}`}
        def={def}
        master={master}
        open={!!editRow}
        row={editRow}
        onClose={() => setEditRow(null)}
        onDone={invalidate}
      />
    </div>
  );
}

function MasterForm({
  def,
  master,
  open,
  row,
  onClose,
  onDone,
}: {
  def: MasterDef;
  master: string;
  open: boolean;
  row: BaseRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [serverError, setServerError] = useState('');
  const form = useForm<FieldValues>({
    resolver: zodResolver(def.schema as never),
    values: row
      ? (Object.fromEntries(Object.keys(def.empty).map((k) => [k, row[k] ?? def.empty[k]])) as FieldValues)
      : (def.empty as FieldValues),
  });

  const save = useMutation({
    mutationFn: (payload: FieldValues) =>
      row
        ? api.put(`/api/masters/${master}/${row.id}`, payload)
        : api.post(`/api/masters/${master}`, payload),
    onSuccess: () => {
      onDone();
      onClose();
      form.reset(def.empty as FieldValues);
      setServerError('');
    },
    onError: (err) => setServerError(err instanceof ApiError ? err.message : 'Save failed.'),
  });

  return (
    <Modal
      title={row ? `Edit ${def.singular}` : `New ${def.singular}`}
      open={open}
      onClose={onClose}
    >
      <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="space-y-4">
        {def.fields.map((f) => {
          const error = form.formState.errors[f.name]?.message as string | undefined;
          switch (f.kind) {
            case 'text':
              return (
                <Field key={f.name} label={f.label} hint={f.hint} error={error}>
                  <TextInput {...form.register(f.name)} />
                </Field>
              );
            case 'textarea':
              return (
                <Field key={f.name} label={f.label} error={error}>
                  <textarea
                    {...form.register(f.name)}
                    rows={2}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-200"
                  />
                </Field>
              );
            case 'number':
              return (
                <Field key={f.name} label={f.label} hint={f.hint} error={error}>
                  <TextInput type="number" {...form.register(f.name, { valueAsNumber: true })} />
                </Field>
              );
            case 'money':
              return (
                <Field key={f.name} label={f.label} hint={f.hint} error={error}>
                  <Controller
                    control={form.control}
                    name={f.name as Path<FieldValues>}
                    render={({ field }) => (
                      <MoneyInput
                        paise={(field.value as number | null) ?? null}
                        onChange={(p) =>
                          field.onChange((p ?? 0) as PathValue<FieldValues, Path<FieldValues>>)
                        }
                      />
                    )}
                  />
                </Field>
              );
            case 'image':
              return (
                <Field key={f.name} label={f.label} error={error}>
                  <Controller
                    control={form.control}
                    name={f.name as Path<FieldValues>}
                    render={({ field }) => (
                      <ImageInput
                        path={(field.value as string | null) ?? null}
                        onChange={(p) => field.onChange(p as PathValue<FieldValues, Path<FieldValues>>)}
                      />
                    )}
                  />
                </Field>
              );
            case 'select':
              return (
                <Field key={f.name} label={f.label} error={error}>
                  <Select {...form.register(f.name)}>
                    {f.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              );
          }
        })}
        <ErrorText>{serverError}</ErrorText>
        <Button type="submit" disabled={save.isPending} className="w-full">
          {save.isPending ? 'Saving…' : row ? 'Save changes' : `Create ${def.singular}`}
        </Button>
      </form>
    </Modal>
  );
}
