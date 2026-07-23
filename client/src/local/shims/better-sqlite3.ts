/**
 * `better-sqlite3` is a native Node addon and cannot exist inside the WebView. The
 * in-app server installs a SQLite-WASM connection through setDatabaseOpener() before
 * anything opens a database, so this constructor is never reached — it exists only so
 * the import in db/connection.ts resolves, and it fails loudly if that ever changes.
 */
export default class Database {
  constructor(_file: string) {
    throw new Error(
      'better-sqlite3 is not available in the app runtime — the SQLite-WASM opener was not installed.',
    );
  }
}
