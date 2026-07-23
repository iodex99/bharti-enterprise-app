/**
 * A tiny in-memory `node:fs` for the in-app server.
 *
 * After migration 003 the only things the runtime-neutral server code reads from a
 * "filesystem" are build artefacts (the migration SQL files, version.json) and a couple
 * of small flag files. Business data lives in SQLite; photos live in SQLite; backups are
 * exported natively. So this shim does NOT pretend to be a real filesystem — it serves
 * the bundled build artefacts and keeps small writes in memory for the current session.
 *
 * Anything that genuinely needs durable file storage on Android is deliberately not part
 * of the worker bundle (see routes/system.node.routes.ts).
 */

// Migration SQL is bundled at build time so the runner needs no real directory.
const migrationModules = import.meta.glob('../../../../server/src/db/migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const MIGRATIONS: Record<string, string> = {};
for (const [file, sql] of Object.entries(migrationModules)) {
  MIGRATIONS[file.slice(file.lastIndexOf('/') + 1)] = sql;
}

declare const __APP_VERSION__: string;
const VERSION_JSON = JSON.stringify({
  version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0-dev',
});

const memory = new Map<string, Uint8Array>();
const directories = new Set<string>(['/']);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function isMigrationsDir(target: string): boolean {
  return /(^|\/)migrations\/?$/.test(target);
}
function migrationName(target: string): string | null {
  const match = /(^|\/)migrations\/([^/]+\.sql)$/.exec(target);
  return match ? match[2]! : null;
}
function isVersionFile(target: string): boolean {
  return /(^|\/)version\.json$/.test(target);
}

export function existsSync(target: string): boolean {
  if (isVersionFile(target)) return true;
  if (isMigrationsDir(target)) return true;
  const name = migrationName(target);
  if (name) return name in MIGRATIONS;
  return memory.has(target) || directories.has(target);
}

export function readFileSync(target: string, encoding?: string): string | Uint8Array {
  const asText = encoding === 'utf8' || encoding === 'utf-8';
  if (isVersionFile(target)) return asText ? VERSION_JSON : encoder.encode(VERSION_JSON);
  const name = migrationName(target);
  if (name) {
    const sql = MIGRATIONS[name];
    if (sql === undefined) throw fsError('ENOENT', target);
    return asText ? sql : encoder.encode(sql);
  }
  const bytes = memory.get(target);
  if (!bytes) throw fsError('ENOENT', target);
  return asText ? decoder.decode(bytes) : bytes;
}

export function writeFileSync(target: string, data: string | Uint8Array): void {
  memory.set(target, typeof data === 'string' ? encoder.encode(data) : data);
}

export function readdirSync(
  target: string,
  options?: { withFileTypes?: boolean },
): string[] | Array<{ name: string; isFile(): boolean; isDirectory(): boolean }> {
  const names = isMigrationsDir(target) ? Object.keys(MIGRATIONS).sort() : [];
  if (options?.withFileTypes) {
    return names.map((name) => ({ name, isFile: () => true, isDirectory: () => false }));
  }
  return names;
}

export function mkdirSync(target: string, _options?: { recursive?: boolean }): void {
  directories.add(target);
}

export function rmSync(target: string, _options?: { force?: boolean; recursive?: boolean }): void {
  memory.delete(target);
  directories.delete(target);
}

export function statSync(target: string): { size: number; isFile(): boolean; isDirectory(): boolean; mtime: Date } {
  const bytes = memory.get(target);
  if (!bytes && !directories.has(target) && !existsSync(target)) throw fsError('ENOENT', target);
  return {
    size: bytes?.byteLength ?? 0,
    isFile: () => !directories.has(target),
    isDirectory: () => directories.has(target),
    mtime: new Date(0),
  };
}

export function copyFileSync(from: string, to: string): void {
  const bytes = memory.get(from);
  if (!bytes) throw fsError('ENOENT', from);
  memory.set(to, bytes.slice());
}

export function renameSync(from: string, to: string): void {
  const bytes = memory.get(from);
  if (!bytes) throw fsError('ENOENT', from);
  memory.set(to, bytes);
  memory.delete(from);
}

export function unlinkSync(target: string): void {
  memory.delete(target);
}

function fsError(code: string, target: string): Error {
  return Object.assign(new Error(`${code}: no such file or directory, '${target}'`), { code });
}

const fs = {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  rmSync,
  statSync,
  copyFileSync,
  renameSync,
  unlinkSync,
};

export default fs;
