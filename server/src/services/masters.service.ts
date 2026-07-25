import type { ZodType } from 'zod';
import {
  colorSchema,
  contractorSchema,
  RAW_CLOTH_MODEL_CODE,
  sizeSchema,
  staffSchema,
  vendorSchema,
} from '@shared';
import type { Db } from '../db/connection';
import { nowIso } from '../db/connection';
import { audit } from './audit.service';

/**
 * Generic CRUD over the six master tables. All mutations are admin-only (enforced at the
 * route layer), audited, and soft-delete only. Deactivation blocks NEW use (enforced by
 * the transaction services which select active rows only); soft delete is allowed only
 * when nothing references the row.
 */

export type MasterKey = 'colors' | 'sizes' | 'vendors' | 'contractors' | 'staff';

type FieldMap = Record<string, string>; // payload key -> column

export type MasterConfig = {
  table: string;
  entityType: string;
  schema: ZodType;
  fields: FieldMap;
  uniqueBy: { payloadKey: string; column: string; label: string };
  searchColumns: string[];
  orderBy: string;
  /** tables that may reference this master: soft delete blocked when any row exists */
  refChecks: Array<{ table: string; column: string; label: string }>;
};

export const MASTERS: Record<MasterKey, MasterConfig> = {
  // models are NOT a master any more (ADR-030): codes are typed at cutting
  colors: {
    table: 'colors',
    entityType: 'color',
    schema: colorSchema,
    fields: { name: 'name', colorCode: 'color_code' },
    uniqueBy: { payloadKey: 'name', column: 'name', label: 'Color name' },
    searchColumns: ['name'],
    orderBy: 'name',
    refChecks: [
      { table: 'purchases', column: 'color_id', label: 'purchases' },
      { table: 'job_cards', column: 'color_id', label: 'job cards' },
      { table: 'stock_ledger', column: 'color_id', label: 'stock movements' },
    ],
  },
  sizes: {
    table: 'sizes',
    entityType: 'size',
    schema: sizeSchema,
    fields: { code: 'code', description: 'description', sortOrder: 'sort_order' },
    uniqueBy: { payloadKey: 'code', column: 'code', label: 'Size code' },
    searchColumns: ['code', 'description'],
    orderBy: 'sort_order, code',
    refChecks: [
      { table: 'cutting_lines', column: 'size_id', label: 'cutting batches' },
      { table: 'job_card_lines', column: 'size_id', label: 'job cards' },
      { table: 'stock_ledger', column: 'size_id', label: 'stock movements' },
    ],
  },
  vendors: {
    table: 'vendors',
    entityType: 'vendor',
    schema: vendorSchema,
    fields: {
      name: 'name',
      contactPerson: 'contact_person',
      mobile: 'mobile',
      address: 'address',
      gstin: 'gstin',
      notes: 'notes',
    },
    uniqueBy: { payloadKey: 'name', column: 'name', label: 'Vendor name' },
    searchColumns: ['name', 'contact_person', 'mobile', 'gstin'],
    orderBy: 'name',
    refChecks: [{ table: 'purchases', column: 'vendor_id', label: 'purchases' }],
  },
  contractors: {
    table: 'contractors',
    entityType: 'contractor',
    schema: contractorSchema,
    fields: {
      name: 'name',
      contactPerson: 'contact_person',
      mobile: 'mobile',
      address: 'address',
      defaultRatePaisePerDozen: 'default_rate_paise_per_dozen',
      imagePath: 'image_path',
      notes: 'notes',
    },
    uniqueBy: { payloadKey: 'name', column: 'name', label: 'Contractor name' },
    searchColumns: ['name', 'contact_person', 'mobile'],
    orderBy: 'name',
    refChecks: [
      { table: 'job_cards', column: 'contractor_id', label: 'job cards' },
      { table: 'contractor_payments', column: 'contractor_id', label: 'payments' },
    ],
  },
  staff: {
    table: 'staff',
    entityType: 'staff',
    schema: staffSchema,
    fields: {
      name: 'name',
      mobile: 'mobile',
      role: 'role',
      defaultRatePaisePerDozen: 'default_rate_paise_per_dozen',
      imagePath: 'image_path',
      notes: 'notes',
    },
    uniqueBy: { payloadKey: 'name', column: 'name', label: 'Staff name' },
    searchColumns: ['name', 'mobile'],
    orderBy: 'name',
    refChecks: [
      { table: 'check_issues', column: 'staff_id', label: 'checking records' },
      { table: 'pack_issues', column: 'staff_id', label: 'packing records' },
      { table: 'staff_payments', column: 'staff_id', label: 'payments' },
    ],
  },
};

type Row = Record<string, unknown> & { id: number };

function toApi(cfg: MasterConfig, row: Row): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: row.id,
    isActive: !!row.is_active,
    createdAt: row.created_at,
  };
  for (const [key, column] of Object.entries(cfg.fields)) out[key] = row[column];
  return out;
}

export function listMaster(
  cfg: MasterConfig,
  db: Db,
  opts: { q?: string; includeInactive?: boolean },
): Record<string, unknown>[] {
  const where: string[] = ['deleted_at IS NULL'];
  const params: unknown[] = [];
  if (!opts.includeInactive) where.push('is_active = 1');
  // the RAW-CLOTH sentinel is bookkeeping, not a real model — never listed, never reactivatable
  if (cfg.table === 'models') {
    where.push('code != ?');
    params.push(RAW_CLOTH_MODEL_CODE);
  }
  if (opts.q) {
    where.push(`(${cfg.searchColumns.map((c) => `${c} LIKE ?`).join(' OR ')})`);
    for (let i = 0; i < cfg.searchColumns.length; i++) params.push(`%${opts.q}%`);
  }
  const rows = db
    .prepare(`SELECT * FROM ${cfg.table} WHERE ${where.join(' AND ')} ORDER BY ${cfg.orderBy}`)
    .all(...params) as Row[];
  return rows.map((r) => toApi(cfg, r));
}

export type MasterResult =
  | { ok: true; id: number }
  | { ok: false; code: number; error: string };

export function createMaster(
  cfg: MasterConfig,
  db: Db,
  payload: Record<string, unknown>,
  userId: number,
  ip: string | null,
): MasterResult {
  const uniqueValue = payload[cfg.uniqueBy.payloadKey];
  const dupe = db
    .prepare(
      `SELECT id FROM ${cfg.table} WHERE ${cfg.uniqueBy.column} = ? COLLATE NOCASE AND deleted_at IS NULL`,
    )
    .get(uniqueValue);
  if (dupe) return { ok: false, code: 409, error: `${cfg.uniqueBy.label} already exists.` };

  const columns = Object.values(cfg.fields);
  const values = Object.keys(cfg.fields).map((k) => payload[k] ?? null);
  let id = 0;
  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO ${cfg.table} (${columns.join(', ')}, created_by)
         VALUES (${columns.map(() => '?').join(', ')}, ?)`,
      )
      .run(...values, userId);
    id = Number(info.lastInsertRowid);
    audit(db, { userId, action: 'create', entityType: cfg.entityType, entityId: id, new: payload, ip });
  });
  tx();
  return { ok: true, id };
}

export function updateMaster(
  cfg: MasterConfig,
  db: Db,
  id: number,
  payload: Record<string, unknown>,
  userId: number,
  ip: string | null,
): MasterResult {
  const existing = db
    .prepare(`SELECT * FROM ${cfg.table} WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as Row | undefined;
  if (!existing) return { ok: false, code: 404, error: 'Record not found.' };

  const uniqueValue = payload[cfg.uniqueBy.payloadKey];
  const dupe = db
    .prepare(
      `SELECT id FROM ${cfg.table}
       WHERE ${cfg.uniqueBy.column} = ? COLLATE NOCASE AND deleted_at IS NULL AND id != ?`,
    )
    .get(uniqueValue, id);
  if (dupe) return { ok: false, code: 409, error: `${cfg.uniqueBy.label} already exists.` };

  const oldApi = toApi(cfg, existing);
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE ${cfg.table} SET ${Object.values(cfg.fields)
        .map((c) => `${c} = ?`)
        .join(', ')} WHERE id = ?`,
    ).run(...Object.keys(cfg.fields).map((k) => payload[k] ?? null), id);
    audit(db, {
      userId,
      action: 'update',
      entityType: cfg.entityType,
      entityId: id,
      old: oldApi,
      new: payload,
      ip,
    });
  });
  tx();
  return { ok: true, id };
}

export function setMasterActive(
  cfg: MasterConfig,
  db: Db,
  id: number,
  active: boolean,
  userId: number,
  ip: string | null,
): MasterResult {
  const existing = db
    .prepare(`SELECT id, is_active FROM ${cfg.table} WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as { id: number; is_active: number } | undefined;
  if (!existing) return { ok: false, code: 404, error: 'Record not found.' };
  const tx = db.transaction(() => {
    db.prepare(`UPDATE ${cfg.table} SET is_active = ? WHERE id = ?`).run(active ? 1 : 0, id);
    audit(db, {
      userId,
      action: active ? 'reactivate' : 'deactivate',
      entityType: cfg.entityType,
      entityId: id,
      old: { isActive: !!existing.is_active },
      new: { isActive: active },
      ip,
    });
  });
  tx();
  return { ok: true, id };
}

export function softDeleteMaster(
  cfg: MasterConfig,
  db: Db,
  id: number,
  userId: number,
  ip: string | null,
): MasterResult {
  const existing = db
    .prepare(`SELECT * FROM ${cfg.table} WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as Row | undefined;
  if (!existing) return { ok: false, code: 404, error: 'Record not found.' };

  for (const ref of cfg.refChecks) {
    const used = db
      .prepare(`SELECT COUNT(*) AS n FROM ${ref.table} WHERE ${ref.column} = ?`)
      .get(id) as { n: number };
    if (used.n > 0) {
      return {
        ok: false,
        code: 409,
        error: `Cannot delete: used by ${used.n} ${ref.label}. Deactivate it instead.`,
      };
    }
  }

  const tx = db.transaction(() => {
    db.prepare(`UPDATE ${cfg.table} SET deleted_at = ?, is_active = 0 WHERE id = ?`).run(
      nowIso(),
      id,
    );
    audit(db, {
      userId,
      action: 'delete',
      entityType: cfg.entityType,
      entityId: id,
      old: toApi(cfg, existing),
      ip,
    });
  });
  tx();
  return { ok: true, id };
}
