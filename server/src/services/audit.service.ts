import type { Db } from '../db/connection';

export type AuditEntry = {
  userId: number | null;
  action: string; // create | update | void | deactivate | reactivate | login | logout | ...
  entityType: string;
  entityId?: number | null;
  old?: unknown;
  new?: unknown;
  ip?: string | null;
};

/**
 * Append an audit row. MUST be called inside the same db.transaction as the change
 * it records so audit and data commit or roll back together.
 */
export function audit(db: Db, entry: AuditEntry): void {
  db.prepare(
    `INSERT INTO audit_log (user_id, action, entity_type, entity_id, old_json, new_json, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.userId,
    entry.action,
    entry.entityType,
    entry.entityId ?? null,
    entry.old === undefined ? null : JSON.stringify(entry.old),
    entry.new === undefined ? null : JSON.stringify(entry.new),
    entry.ip ?? null,
  );
}
