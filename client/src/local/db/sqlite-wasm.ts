import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

/**
 * SQLite for the in-app server.
 *
 * The Android app has no Node process, so the same service code runs against a
 * WebAssembly build of SQLite instead of better-sqlite3. This module exposes the
 * exact slice of the better-sqlite3 API the server uses — prepare/run/get/all,
 * exec, transaction (with savepoint nesting), pragma, inTransaction — so nothing
 * above the driver has to know which engine it is talking to.
 *
 * Storage: the OPFS "SAH pool" VFS. It writes through real file handles inside the
 * browser's origin-private filesystem, so writes are incremental and durable exactly
 * like a file on disk — no export-the-whole-database-on-every-write. It needs no
 * COOP/COEP headers, which the alternative OPFS VFS does.
 *
 * The origin (https://localhost in the Capacitor shell) owns that filesystem, and the
 * app bundle is swapped underneath it on update — which is why an update cannot touch
 * business data. If OPFS is unavailable (very old Android System WebView) we fall back
 * to an in-memory database persisted to IndexedDB, and say so loudly.
 */

type Sqlite3Static = Awaited<ReturnType<typeof sqlite3InitModule>>;
type Oo1Db = InstanceType<Sqlite3Static['oo1']['DB']>;

export type RunResult = { changes: number; lastInsertRowid: number };
export type BindValue = string | number | bigint | Uint8Array | null;
export type Row = Record<string, unknown>;

export interface SqlStatement {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): Row | undefined;
  all(...params: unknown[]): Row[];
}

export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
  exec(sql: string): void;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
  pragma(source: string): unknown;
  readonly inTransaction: boolean;
  close(): void;
}

export type Persistence = 'opfs' | 'memory';

export interface LocalDatabase extends SqlDatabase {
  readonly persistence: Persistence;
  /** Whole-database bytes — the unit of backup, export and "move to a new device". */
  exportBytes(): Promise<Uint8Array>;
  /** Replace the entire database with these bytes (restore). Closes and reopens. */
  importBytes(bytes: Uint8Array): Promise<void>;
  /** Memory fallback only: push the current bytes to IndexedDB. No-op on OPFS. */
  flush(): Promise<void>;
}

export const REAL_DB = '/app.db';
export const DEMO_DB = '/demo.db';
const OPFS_POOL_NAME = 'bharti-data';
const IDB_NAME = 'bharti-fallback';
const IDB_STORE = 'db';

let sqlite3: Sqlite3Static | null = null;

async function loadSqlite(): Promise<Sqlite3Static> {
  if (!sqlite3) {
    // The published typings declare no parameters, but the module accepts the standard
    // Emscripten options object — that is how its own logging is redirected.
    const init = sqlite3InitModule as unknown as (opts: {
      print(msg: string): void;
      printErr(msg: string): void;
    }) => Promise<Sqlite3Static>;
    sqlite3 = await init({
      print: (msg: string) => console.log('[sqlite]', msg),
      printErr: (msg: string) => console.error('[sqlite]', msg),
    });
  }
  return sqlite3;
}

// ---------------------------------------------------------------------------
// Value marshalling — keep behaviour identical to better-sqlite3 for the callers.
// ---------------------------------------------------------------------------

function normalizeBind(params: unknown[]): BindValue[] {
  // better-sqlite3 is called as .run(a, b, c) everywhere in this codebase, but it
  // also accepts a single array; support both so call sites never have to care.
  const flat =
    params.length === 1 && Array.isArray(params[0]) ? (params[0] as unknown[]) : params;
  return flat.map((value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
      return value;
    }
    // Objects/dates are never bound in this codebase; stringify rather than crash.
    return String(value);
  });
}

/** int64 values arrive as BigInt; every id/quantity in this app fits a JS number. */
function normalizeOut(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value;
  }
  return value;
}

// ---------------------------------------------------------------------------

class WasmDatabase implements LocalDatabase {
  readonly persistence: Persistence;

  private db: Oo1Db;
  private readonly api: Sqlite3Static;
  private readonly reopen: () => Promise<Oo1Db>;
  private readonly exporter: () => Uint8Array | Promise<Uint8Array>;
  private readonly importer: (bytes: Uint8Array) => Promise<void>;
  private readonly flusher: () => Promise<void>;
  private depth = 0;
  private closed = false;

  constructor(opts: {
    db: Oo1Db;
    api: Sqlite3Static;
    persistence: Persistence;
    reopen: () => Promise<Oo1Db>;
    exporter: (db: Oo1Db) => Uint8Array | Promise<Uint8Array>;
    importer: (bytes: Uint8Array) => Promise<void>;
    flusher: (db: Oo1Db) => Promise<void>;
  }) {
    this.db = opts.db;
    this.api = opts.api;
    this.persistence = opts.persistence;
    this.reopen = opts.reopen;
    this.exporter = () => opts.exporter(this.db);
    this.importer = opts.importer;
    this.flusher = () => opts.flusher(this.db);
  }

  get inTransaction(): boolean {
    return this.depth > 0;
  }

  prepare(sql: string): SqlStatement {
    return new WasmStatement(this, sql);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  /**
   * better-sqlite3 semantics: returns a callable that runs fn inside a transaction,
   * committing on return and rolling back on throw. Nested calls use SAVEPOINTs so an
   * inner failure unwinds only its own work — the ledger service relies on this.
   */
  transaction<T extends (...args: never[]) => unknown>(fn: T): T {
    const wrapped = (...args: never[]): unknown => {
      const level = this.depth;
      this.exec(level === 0 ? 'BEGIN' : `SAVEPOINT bh_sp_${level}`);
      this.depth = level + 1;
      let result: unknown;
      try {
        result = fn(...args);
      } catch (err) {
        this.depth = level;
        try {
          if (level === 0) this.exec('ROLLBACK');
          else this.exec(`ROLLBACK TO bh_sp_${level}; RELEASE bh_sp_${level}`);
        } catch (unwindErr) {
          console.error('[sqlite] rollback failed', unwindErr);
        }
        throw err;
      }
      this.depth = level;
      this.exec(level === 0 ? 'COMMIT' : `RELEASE bh_sp_${level}`);
      return result;
    };
    return wrapped as unknown as T;
  }

  /** Tolerant: unsupported pragmas (WAL under the SAH pool VFS) must not abort boot. */
  pragma(source: string): unknown {
    const sql = `PRAGMA ${source}`;
    try {
      const rows: unknown[] = [];
      this.db.exec({ sql, rowMode: 'object', callback: (row: unknown) => void rows.push(row) });
      return rows;
    } catch (err) {
      console.warn(`[sqlite] ${sql} not supported on this VFS:`, (err as Error).message);
      return [];
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  async exportBytes(): Promise<Uint8Array> {
    return this.exporter();
  }

  async importBytes(bytes: Uint8Array): Promise<void> {
    this.db.close();
    await this.importer(bytes);
    this.db = await this.reopen();
    this.depth = 0;
    this.closed = false;
  }

  flush(): Promise<void> {
    return this.flusher();
  }

  // -- internals used by WasmStatement --------------------------------------

  /** @internal */
  handle(): Oo1Db {
    return this.db;
  }

  /** @internal */
  lastRun(): RunResult {
    const capi = this.api.capi as unknown as {
      sqlite3_changes(p: unknown): number;
      sqlite3_last_insert_rowid(p: unknown): number | bigint;
    };
    const pointer = (this.db as unknown as { pointer: unknown }).pointer;
    return {
      changes: capi.sqlite3_changes(pointer),
      lastInsertRowid: Number(capi.sqlite3_last_insert_rowid(pointer)),
    };
  }
}

class WasmStatement implements SqlStatement {
  constructor(
    private readonly owner: WasmDatabase,
    private readonly sql: string,
  ) {}

  run(...params: unknown[]): RunResult {
    this.each(params, null);
    return this.owner.lastRun();
  }

  get(...params: unknown[]): Row | undefined {
    let first: Row | undefined;
    this.each(params, (row) => {
      if (first === undefined) first = row;
      return first === undefined; // keep stepping only until we have one
    });
    return first;
  }

  all(...params: unknown[]): Row[] {
    const rows: Row[] = [];
    this.each(params, (row) => {
      rows.push(row);
      return true;
    });
    return rows;
  }

  /**
   * One prepare per call. Statement caching would be faster, but the services
   * re-enter the same SQL from nested transactions and loops, and a shared
   * statement handle cannot be stepped re-entrantly — correctness first; at this
   * app's write volume (tens of statements per user action) it is not measurable.
   */
  private each(params: unknown[], onRow: ((row: Row) => boolean) | null): void {
    const stmt = this.owner.handle().prepare(this.sql);
    try {
      const bind = normalizeBind(params);
      if (bind.length > 0) stmt.bind(bind as never);
      if (!onRow) {
        stmt.step();
        return;
      }
      const columns = stmt.getColumnNames();
      while (stmt.step()) {
        const row: Row = {};
        for (let i = 0; i < columns.length; i += 1) {
          row[columns[i] as string] = normalizeOut(stmt.get(i));
        }
        if (!onRow(row)) break;
      }
    } finally {
      stmt.finalize();
    }
  }
}

// ---------------------------------------------------------------------------
// Store: owns the VFS and hands out connections by filename. Two databases can
// exist side by side — the real one and the demo one — exactly as the Node host
// keeps a separate demo data directory.
// ---------------------------------------------------------------------------

export interface LocalStore {
  readonly persistence: Persistence;
  readonly warning?: string;
  open(name: string): Promise<LocalDatabase>;
  exists(name: string): Promise<boolean>;
  remove(name: string): Promise<void>;
}

export async function openLocalStore(): Promise<LocalStore> {
  const api = await loadSqlite();

  if (typeof api.installOpfsSAHPoolVfs === 'function') {
    try {
      const pool = await api.installOpfsSAHPoolVfs({
        name: OPFS_POOL_NAME,
        clearOnInit: false,
        initialCapacity: 8,
      });
      return {
        persistence: 'opfs',
        async open(name: string) {
          const openPooled = (): Oo1Db => new pool.OpfsSAHPoolDb(name) as unknown as Oo1Db;
          const db = new WasmDatabase({
            db: openPooled(),
            api,
            persistence: 'opfs',
            reopen: async () => openPooled(),
            exporter: () => pool.exportFile(name),
            importer: async (bytes) => {
              await pool.importDb(name, bytes);
            },
            flusher: async () => {
              /* the SAH pool writes through — nothing to flush */
            },
          });
          applyPragmas(db);
          return db;
        },
        async exists(name: string) {
          return pool.getFileNames().includes(name);
        },
        async remove(name: string) {
          pool.unlink(name);
        },
      };
    } catch (err) {
      console.error('[sqlite] OPFS unavailable, falling back to IndexedDB:', err);
    }
  }

  // Fallback: in-memory databases, whole-file snapshots pushed to IndexedDB.
  return {
    persistence: 'memory',
    warning:
      'This device’s browser engine does not support OPFS storage. The app is running on a slower fallback — update Android System WebView from the Play Store.',
    async open(name: string) {
      let pending = await idbLoad(name);
      const openMemory = (bytes: Uint8Array | null): Oo1Db => {
        const handle = new api.oo1.DB(name, 'ct') as unknown as Oo1Db;
        if (bytes && bytes.byteLength > 0) deserializeInto(api, handle, bytes);
        return handle;
      };
      const db = new WasmDatabase({
        db: openMemory(pending),
        api,
        persistence: 'memory',
        reopen: async () => openMemory(pending),
        exporter: (handle) => exportInMemory(api, handle),
        importer: async (bytes) => {
          pending = bytes;
          await idbSave(name, bytes);
        },
        flusher: async (handle) => {
          await idbSave(name, exportInMemory(api, handle));
        },
      });
      applyPragmas(db);
      return db;
    },
    async exists(name: string) {
      return (await idbLoad(name)) !== null;
    },
    async remove(name: string) {
      await idbDelete(name);
    },
  };
}

function applyPragmas(db: SqlDatabase): void {
  // WAL is meaningless (and unsupported) on the single-connection OPFS pool; the rest
  // mirror the Node connection so behaviour matches.
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
}

function exportInMemory(api: Sqlite3Static, db: Oo1Db): Uint8Array {
  const capi = api.capi as unknown as { sqlite3_js_db_export(p: unknown): Uint8Array };
  return capi.sqlite3_js_db_export((db as unknown as { pointer: unknown }).pointer);
}

function deserializeInto(api: Sqlite3Static, db: Oo1Db, bytes: Uint8Array): void {
  const capi = api.capi as unknown as {
    sqlite3_deserialize(
      p: unknown,
      schema: string,
      data: number,
      dbSize: number,
      bufSize: number,
      flags: number,
    ): number;
    SQLITE_DESERIALIZE_FREEONCLOSE: number;
    SQLITE_DESERIALIZE_RESIZEABLE: number;
  };
  const wasm = api.wasm as unknown as { allocFromTypedArray(a: Uint8Array): number };
  const ptr = wasm.allocFromTypedArray(bytes);
  const rc = capi.sqlite3_deserialize(
    (db as unknown as { pointer: unknown }).pointer,
    'main',
    ptr,
    bytes.byteLength,
    bytes.byteLength,
    capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE,
  );
  if (rc !== 0) throw new Error(`sqlite3_deserialize failed (${rc})`);
}

// -- tiny IndexedDB blob store for the fallback path ------------------------

function idbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'));
  });
}

async function idbLoad(key: string): Promise<Uint8Array | null> {
  try {
    const idb = await idbOpen();
    return await new Promise((resolve, reject) => {
      const req = idb.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
      req.onsuccess = () => {
        const value = req.result as ArrayBuffer | undefined;
        resolve(value ? new Uint8Array(value) : null);
      };
      req.onerror = () => reject(req.error ?? new Error('idb get failed'));
    });
  } catch {
    return null;
  }
}

async function idbSave(key: string, bytes: Uint8Array): Promise<void> {
  const idb = await idbOpen();
  await new Promise<void>((resolve, reject) => {
    const tx = idb.transaction(IDB_STORE, 'readwrite');
    // structuredClone of a view into WASM memory is unsafe — copy first
    const copy = bytes.slice().buffer;
    tx.objectStore(IDB_STORE).put(copy, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('idb put failed'));
  });
}

async function idbDelete(key: string): Promise<void> {
  const idb = await idbOpen();
  await new Promise<void>((resolve, reject) => {
    const tx = idb.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('idb delete failed'));
  });
}
