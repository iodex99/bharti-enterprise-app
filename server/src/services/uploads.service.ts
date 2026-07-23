import crypto from 'node:crypto';
import type { Db } from '../db/connection';

/**
 * Uploaded photos live in the database (migration 003), not on disk — the Android
 * runtime has no synchronous filesystem, and it keeps "the whole business is one
 * file" true for backup/restore/moving to a new device.
 *
 * The public identifier is unchanged from the filesystem era: '/uploads/<YYYY-MM>/<hex>.webp'
 * is what document rows store and what the client requests.
 */

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const UPLOAD_MAX_DIM = 1600;

const PATH_RE = /^\/uploads\/\d{4}-\d{2}\/[a-f0-9]{16}\.webp$/;

export function newUploadPath(): string {
  const month = new Date().toISOString().slice(0, 7);
  return `/uploads/${month}/${crypto.randomBytes(8).toString('hex')}.webp`;
}

/** Store already-processed webp bytes. Returns the public path. */
export function storeUpload(
  db: Db,
  bytes: Uint8Array,
  userId: number | null,
  mime = 'image/webp',
): string {
  const path = newUploadPath();
  db.prepare(
    'INSERT INTO upload_files (path, mime, size_bytes, bytes, created_by) VALUES (?, ?, ?, ?, ?)',
  ).run(path, mime, bytes.byteLength, bytes, userId);
  return path;
}

export type StoredUpload = { bytes: Uint8Array; mime: string; sizeBytes: number };

/**
 * Look up by public path. Unknown or malformed paths return null — a keyed lookup
 * has no traversal surface, unlike the filesystem serving it replaced.
 */
export function readUpload(db: Db, path: string): StoredUpload | null {
  if (!PATH_RE.test(path)) return null;
  const row = db
    .prepare('SELECT bytes, mime, size_bytes AS sizeBytes FROM upload_files WHERE path = ?')
    .get(path) as { bytes: Uint8Array; mime: string; sizeBytes: number } | undefined;
  if (!row) return null;
  return { bytes: toBytes(row.bytes), mime: row.mime, sizeBytes: row.sizeBytes };
}

export function countUploads(db: Db): number {
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM upload_files').get() as { n: number }).n;
  } catch {
    return 0; // table not migrated yet (e.g. inspecting an older backup)
  }
}

export function uploadBytesTotal(db: Db): number {
  try {
    return (
      (db.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS n FROM upload_files').get() as {
        n: number;
      }).n ?? 0
    );
  } catch {
    return 0;
  }
}

/** better-sqlite3 hands back Buffer, sqlite-wasm hands back Uint8Array. */
function toBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
  if (value instanceof Uint8Array) return value;
  return new Uint8Array(value);
}
