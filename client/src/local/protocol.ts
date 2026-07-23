/**
 * Message protocol between the page (UI) and the in-app server worker.
 *
 * The worker owns the database and runs the real Express routes; the page never touches
 * data directly. Every message carries an id so responses can be matched to requests —
 * this is the app's equivalent of an HTTP connection.
 */

export type WorkerFile = {
  buffer: ArrayBuffer;
  originalname: string;
  mimetype: string;
  size: number;
  fieldname: string;
};

export type ToWorker =
  /** `demo` restores the demo/real choice across an app restart (the worker has no storage). */
  | { kind: 'boot'; id: number; demo: boolean }
  | {
      kind: 'request';
      id: number;
      method: string;
      url: string;
      headers: Record<string, string>;
      body?: ArrayBuffer;
      file?: WorkerFile;
    }
  /** Whole-database bytes, for a backup / "move to a new device" export. */
  | { kind: 'export'; id: number }
  /** Replace the whole database (restore). */
  | { kind: 'import'; id: number; bytes: ArrayBuffer }
  /** Force pending writes out (memory-fallback storage only). */
  | { kind: 'flush'; id: number }
  /** Demo mode: a second, physically separate database on the same device. */
  | { kind: 'demo'; id: number; action: 'status' | 'enter' | 'exit' | 'remove'; fresh?: boolean };

export type BootInfo = {
  version: string;
  persistence: 'opfs' | 'memory';
  warning?: string;
  migrationsApplied: string[];
  demoActive: boolean;
  /** Present only the very first time the app runs on a device. */
  initialAdmin: { username: string; password: string } | null;
};

export type FromWorker =
  | ({ kind: 'ready'; id: number } & BootInfo)
  | {
      kind: 'response';
      id: number;
      status: number;
      headers: Record<string, string>;
      body: ArrayBuffer | null;
    }
  | { kind: 'exported'; id: number; bytes: ArrayBuffer }
  | { kind: 'imported'; id: number }
  | { kind: 'flushed'; id: number }
  | { kind: 'demoStatus'; id: number; active: boolean; exists: boolean }
  | { kind: 'error'; id: number; message: string };
