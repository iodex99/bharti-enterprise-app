/// <reference lib="webworker" />
import { Buffer } from 'buffer';
import type { FromWorker, ToWorker } from './protocol';

/**
 * The in-app server.
 *
 * This worker IS the backend: it opens SQLite (WASM/OPFS), runs the migrations and
 * serves the very same Express routes the Node server does. The UI thread talks to it
 * with request/response messages instead of HTTP, so nothing in the pages had to change.
 *
 * Running it off the UI thread matters: SQLite work here is synchronous, and the app's
 * hard rule is that a transaction is never interrupted. The worker's single thread gives
 * exactly the "one process, one connection" guarantee the ledger engine relies on.
 */

// Server code predates the browser and expects these globals. Installed before the
// server modules are imported — hence the dynamic imports below.
const globals = globalThis as unknown as Record<string, unknown>;
globals.Buffer ??= Buffer;
globals.process ??= {
  env: {},
  platform: 'android',
  argv: [] as string[],
  cwd: () => '/',
  uptime: () => 0,
};

/**
 * Loaded on the first message rather than at module scope: a failure here (a missing
 * chunk after a bad update, an unsupported browser engine) must be reportable to the
 * page, and a module that fails while evaluating can report nothing.
 */
async function loadModules() {
  const [
    expressModule,
    appCore,
    connection,
    dataDirs,
    migrateModule,
    authService,
    demoData,
    configModule,
    imagePort,
    imageProcessor,
    sqliteWasm,
  ] = await Promise.all([
    import('./shims/express'),
    import('../../../server/src/app.core'),
    import('../../../server/src/db/connection'),
    import('../../../server/src/db/dataDirs'),
    import('../../../server/src/db/migrate'),
    import('../../../server/src/services/auth.service'),
    import('../../../server/src/db/demo-data'),
    import('../../../server/src/config'),
    import('../../../server/src/platform/image'),
    import('./image-processor'),
    import('./db/sqlite-wasm'),
  ]);
  return {
    expressModule,
    appCore,
    connection,
    dataDirs,
    migrateModule,
    authService,
    demoData,
    configModule,
    imagePort,
    imageProcessor,
    sqliteWasm,
  };
}

type Modules = Awaited<ReturnType<typeof loadModules>>;
type ServerDb = ReturnType<Modules['connection']['getDb']>;
type ShimApp = ReturnType<Modules['expressModule']['default']>;
type LocalDatabase = Awaited<ReturnType<Awaited<ReturnType<Modules['sqliteWasm']['openLocalStore']>>['open']>>;

let modules: Modules | null = null;
function required(): Modules {
  if (!modules) throw new Error('The app has not started yet.');
  return modules;
}

let store: Awaited<ReturnType<Modules['sqliteWasm']['openLocalStore']>> | null = null;
let database: LocalDatabase | null = null;
let activeName = '/app.db';
let app: ShimApp | null = null;

function post(message: FromWorker, transfer: Transferable[] = []): void {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(message, transfer);
}

/** Point every server module at the current connection. */
function bindConnection(db: LocalDatabase): ServerDb {
  database = db;
  required().connection.closeDb();
  required().connection.setDatabaseOpener(() => db as unknown as ServerDb);
  return required().connection.getDb();
}

function buildApp(): void {
  app = required().expressModule.default();
  required().appCore.mountCoreMiddleware(app as never);
  required().appCore.mountApiRoutes(app as never); // no systemOps: those are native on Android
  required().appCore.mountErrorHandler(app as never);
}

async function boot(id: number, demo: boolean): Promise<void> {
  modules = await loadModules();
  activeName = demo ? required().sqliteWasm.DEMO_DB : required().sqliteWasm.REAL_DB;
  // Keeps isDemoMode() — and therefore the DEMO banner and every demo guard — true.
  required().dataDirs.setDemoMode(demo);
  required().imagePort.setImageProcessor(required().imageProcessor.webviewImageProcessor);
  store = await required().sqliteWasm.openLocalStore();
  const db = bindConnection(await store.open(activeName));

  const migrationsApplied = required().migrateModule.migrate(db);
  const admin = required().authService.ensureInitialAdmin(db);
  buildApp();

  post({
    kind: 'ready',
    id,
    version: required().configModule.config.version,
    persistence: store.persistence,
    warning: store.warning,
    migrationsApplied,
    demoActive: demo,
    initialAdmin:
      admin.created && admin.password ? { username: 'admin', password: admin.password } : null,
  });
}

async function switchDatabase(name: string): Promise<void> {
  if (!store) throw new Error('The app has not started yet.');
  database?.close();
  activeName = name;
  required().dataDirs.setDemoMode(name === required().sqliteWasm.DEMO_DB);
  const db = bindConnection(await store.open(name));
  required().migrateModule.migrate(db);
  buildApp();
}

async function enterDemo(fresh: boolean): Promise<void> {
  if (!store) throw new Error('The app has not started yet.');
  if (activeName === required().sqliteWasm.DEMO_DB) throw new Error('Demo mode is already active.');
  const exists = await store.exists(required().sqliteWasm.DEMO_DB);
  if (fresh && exists) await store.remove(required().sqliteWasm.DEMO_DB);
  await switchDatabase(required().sqliteWasm.DEMO_DB);

  const db = required().connection.getDb();
  const users = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  if (users === 0) {
    const reconciliation = required().demoData.populateDemo(db);
    if (!reconciliation.ok) {
      // Never leave a half-built demo behind — go back to real data and say so.
      await switchDatabase(required().sqliteWasm.REAL_DB);
      await store.remove(required().sqliteWasm.DEMO_DB);
      throw new Error('Demo data failed its own conservation checks — nothing was changed.');
    }
  }
}

async function handleRequest(message: Extract<ToWorker, { kind: 'request' }>): Promise<void> {
  if (!app) throw new Error('The app is still starting up.');
  const response = await app.handleRequest({
    method: message.method,
    url: message.url,
    headers: message.headers,
    rawBody: message.body ? new Uint8Array(message.body) : undefined,
    file: message.file
      ? {
          buffer: new Uint8Array(message.file.buffer),
          originalname: message.file.originalname,
          mimetype: message.file.mimetype,
          size: message.file.size,
          fieldname: message.file.fieldname,
        }
      : undefined,
    ip: 'device',
  });

  // On the memory-fallback path, push writes out immediately so a hard kill loses nothing.
  if (database?.persistence === 'memory' && message.method.toUpperCase() !== 'GET') {
    await database.flush();
  }

  const body = response.body ? toTransferable(response.body) : null;
  post(
    { kind: 'response', id: message.id, status: response.status, headers: response.headers, body },
    body ? [body] : [],
  );
}

/** postMessage cannot transfer a view into WASM memory — copy into a plain buffer. */
function toTransferable(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  try {
    switch (message.kind) {
      case 'boot':
        await boot(message.id, message.demo);
        break;

      case 'request':
        await handleRequest(message);
        break;

      case 'export': {
        if (!database) throw new Error('No database open.');
        const bytes = toTransferable(await database.exportBytes());
        post({ kind: 'exported', id: message.id, bytes }, [bytes]);
        break;
      }

      case 'import': {
        if (!database) throw new Error('No database open.');
        if (activeName !== required().sqliteWasm.REAL_DB) {
          throw new Error('Leave demo mode first — restoring replaces real data.');
        }
        await database.importBytes(new Uint8Array(message.bytes));
        const db = required().connection.getDb();
        required().migrateModule.migrate(db); // forward-migrate an older backup
        db.prepare('DELETE FROM sessions').run(); // sign everyone out of the replaced data
        post({ kind: 'imported', id: message.id });
        break;
      }

      case 'flush':
        await database?.flush();
        post({ kind: 'flushed', id: message.id });
        break;

      case 'demo': {
        if (!store) throw new Error('The app has not started yet.');
        if (message.action === 'enter') await enterDemo(message.fresh ?? false);
        else if (message.action === 'exit') {
          if (activeName !== required().sqliteWasm.DEMO_DB) throw new Error('Demo mode is not active.');
          await switchDatabase(required().sqliteWasm.REAL_DB);
        } else if (message.action === 'remove') {
          if (activeName === required().sqliteWasm.DEMO_DB) {
            throw new Error('Exit demo mode first, then remove the demo data.');
          }
          await store.remove(required().sqliteWasm.DEMO_DB);
        }
        post({
          kind: 'demoStatus',
          id: message.id,
          active: activeName === required().sqliteWasm.DEMO_DB,
          exists: await store.exists(required().sqliteWasm.DEMO_DB),
        });
        break;
      }
    }
  } catch (err) {
    console.error('[in-app server]', err);
    post({ kind: 'error', id: message.id, message: (err as Error).message });
  }
};
