import type { BootInfo, FromWorker, ToWorker, WorkerFile } from './protocol';
import { handleNativeOp, isNativeOpPath } from './native-ops';

/**
 * Connects the UI to the in-app server.
 *
 * `window.fetch` is wrapped so that every request the app already makes — /api/... and
 * /uploads/... — is answered by the worker instead of a network round trip. Nothing in
 * the pages, hooks or React Query setup changes: the app cannot tell whether it is
 * talking to the Express server over HTTP or to the worker in the next thread.
 *
 * Two things HTTP gave us for free have to be done by hand here:
 *  - the session cookie (there is no cookie jar for a worker), and
 *  - multipart uploads (a picked File is passed through as bytes).
 */

const SESSION_STORAGE_KEY = 'bharti.session';
const DEMO_STORAGE_KEY = 'bharti.demo';
const LOCAL_ORIGINS = ['/api/', '/uploads/'];

let worker: Worker | null = null;
let nextId = 1;
let bootInfo: BootInfo | null = null;
const pending = new Map<
  number,
  { resolve: (value: FromWorker) => void; reject: (err: Error) => void }
>();

function send(message: ToWorker, transfer: Transferable[] = []): Promise<FromWorker> {
  if (!worker) return Promise.reject(new Error('The app has not started yet.'));
  return new Promise((resolve, reject) => {
    pending.set(message.id, { resolve, reject });
    worker!.postMessage(message, transfer);
  });
}

function nextMessageId(): number {
  nextId += 1;
  return nextId;
}

// -- session -----------------------------------------------------------------

function readSession(): string | null {
  try {
    return localStorage.getItem(SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeSession(value: string | null): void {
  try {
    if (value) localStorage.setItem(SESSION_STORAGE_KEY, value);
    else localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    /* private mode — the session simply won't survive a restart */
  }
}

/** Mirror the Set-Cookie the auth routes emit into our own store. */
function absorbSetCookie(headers: Record<string, string>): void {
  const raw = headers['set-cookie'];
  if (!raw) return;
  const [pair, ...attributes] = raw.split(';').map((part) => part.trim());
  const index = pair?.indexOf('=') ?? -1;
  if (index === -1) return;
  const value = pair!.slice(index + 1);
  const cleared = attributes.some((a) => /^max-age=0$/i.test(a)) || value === '';
  writeSession(cleared ? null : raw.split(';')[0] ?? null);
}

// -- request translation ------------------------------------------------------

function shouldHandleLocally(url: string): boolean {
  const path = toPath(url);
  return LOCAL_ORIGINS.some((prefix) => path.startsWith(prefix));
}

function toPath(url: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    try {
      const parsed = new URL(url);
      return `${parsed.pathname}${parsed.search}`;
    } catch {
      return url;
    }
  }
  return url.startsWith('/') ? url : `/${url}`;
}

async function extractBody(
  init: RequestInit | undefined,
): Promise<{ body?: ArrayBuffer; file?: WorkerFile; contentType?: string }> {
  const body = init?.body;
  if (body === undefined || body === null) return {};
  if (typeof body === 'string') {
    return { body: new TextEncoder().encode(body).buffer as ArrayBuffer };
  }
  if (body instanceof FormData) {
    for (const [fieldname, value] of body.entries()) {
      if (value instanceof File) {
        return {
          file: {
            buffer: await value.arrayBuffer(),
            originalname: value.name,
            mimetype: value.type,
            size: value.size,
            fieldname,
          },
        };
      }
    }
    return {};
  }
  if (body instanceof Blob) return { body: await body.arrayBuffer() };
  if (body instanceof ArrayBuffer) return { body: body };
  if (ArrayBuffer.isView(body)) {
    return { body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer };
  }
  return {};
}

function normalizeHeaders(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const source = init?.headers;
  if (source instanceof Headers) {
    source.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
  } else if (Array.isArray(source)) {
    for (const [key, value] of source) out[String(key).toLowerCase()] = String(value);
  } else if (source) {
    for (const [key, value] of Object.entries(source)) out[key.toLowerCase()] = String(value);
  }
  return out;
}

async function localFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = toPath(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? 'GET').toUpperCase();

  // Update, backup, restore: these need the device (files, downloads, the app shell),
  // so they are served here rather than by the worker.
  if (isNativeOpPath(url)) {
    return handleNativeOp(url, method, init);
  }

  const headers = normalizeHeaders(init);
  const session = readSession();
  if (session) headers['cookie'] = session;
  headers['origin'] = location.origin;
  headers['host'] = location.host;

  const { body, file } = await extractBody(init);
  if (body && !headers['content-type']) headers['content-type'] = 'application/json';

  const transfer: Transferable[] = [];
  if (body) transfer.push(body);
  if (file) transfer.push(file.buffer);

  const reply = await send(
    { kind: 'request', id: nextMessageId(), method, url, headers, body, file },
    transfer,
  );
  if (reply.kind === 'error') throw new Error(reply.message);
  if (reply.kind !== 'response') throw new Error('Unexpected reply from the in-app server.');

  absorbSetCookie(reply.headers);
  const responseHeaders = new Headers();
  for (const [key, value] of Object.entries(reply.headers)) {
    if (key === 'set-cookie') continue; // not a real cookie; already absorbed
    responseHeaders.set(key, value);
  }
  return new Response(reply.body, { status: reply.status, headers: responseHeaders });
}

// -- lifecycle ----------------------------------------------------------------

export function localServerInfo(): BootInfo | null {
  return bootInfo;
}

export function clearLocalSession(): void {
  writeSession(null);
}

/** Whole-database bytes, for backup / migrate-to-a-new-device. */
export async function exportDatabase(): Promise<Uint8Array> {
  const reply = await send({ kind: 'export', id: nextMessageId() });
  if (reply.kind !== 'exported') {
    throw new Error(reply.kind === 'error' ? reply.message : 'Export failed.');
  }
  return new Uint8Array(reply.bytes);
}

/** Replace ALL data with a backup. Everyone is signed out afterwards. */
export async function importDatabase(bytes: Uint8Array): Promise<void> {
  const copy = bytes.slice().buffer;
  const reply = await send({ kind: 'import', id: nextMessageId(), bytes: copy }, [copy]);
  if (reply.kind !== 'imported') {
    throw new Error(reply.kind === 'error' ? reply.message : 'Restore failed.');
  }
  writeSession(null);
}

export async function flushDatabase(): Promise<void> {
  await send({ kind: 'flush', id: nextMessageId() });
}

/** Demo mode switches the worker onto a second, physically separate database. */
export async function demoCommand(
  action: 'status' | 'enter' | 'exit' | 'remove',
  fresh = false,
): Promise<{ active: boolean; exists: boolean }> {
  const reply = await send({ kind: 'demo', id: nextMessageId(), action, fresh });
  if (reply.kind === 'error') throw new Error(reply.message);
  if (reply.kind !== 'demoStatus') throw new Error('Unexpected reply from the in-app server.');
  if (action !== 'status') {
    // The session lives inside whichever database is active, so it never carries across.
    writeSession(null);
    // The worker has no storage of its own; remember the choice so closing and reopening
    // the app does not silently drop a demo back onto real data.
    try {
      if (reply.active) localStorage.setItem(DEMO_STORAGE_KEY, '1');
      else localStorage.removeItem(DEMO_STORAGE_KEY);
    } catch {
      /* demo mode simply won't survive a restart */
    }
  }
  return { active: reply.active, exists: reply.exists };
}

/**
 * Start the in-app server and take over fetch. Resolves once the database is open and
 * migrated — the UI must not render before that, or the first queries would race the boot.
 */
export async function startLocalServer(): Promise<BootInfo> {
  if (bootInfo) return bootInfo;

  worker = new Worker(new URL('./server.worker.ts', import.meta.url), {
    type: 'module',
    name: 'bharti-server',
  });
  worker.onmessage = (event: MessageEvent<FromWorker>) => {
    const entry = pending.get(event.data.id);
    if (!entry) return;
    pending.delete(event.data.id);
    entry.resolve(event.data);
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || 'The in-app server stopped unexpectedly.');
    for (const [, entry] of pending) entry.reject(error);
    pending.clear();
  };

  let demo = false;
  try {
    demo = localStorage.getItem(DEMO_STORAGE_KEY) === '1';
  } catch {
    /* no storage — start on real data */
  }
  const reply = await send({ kind: 'boot', id: nextMessageId(), demo });
  if (reply.kind === 'error') throw new Error(reply.message);
  if (reply.kind !== 'ready') throw new Error('The in-app server failed to start.');

  const { kind: _kind, id: _id, ...info } = reply;
  bootInfo = info;

  const originalFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return shouldHandleLocally(toPath(url)) ? localFetch(input, init) : originalFetch(input, init);
  }) as typeof window.fetch;

  return info;
}
