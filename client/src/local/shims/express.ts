/**
 * A very small Express-compatible router for the in-app server.
 *
 * The Android build resolves `express` to this module (see vite.config.ts). It is not a
 * general Express implementation — it implements exactly the surface this codebase uses,
 * verified against the routes: Router()/param(), the METHOD(path, ...handlers) forms,
 * mounting with use(prefix, router), the (req, res, next) middleware chain including
 * 4-argument error handlers, async handlers whose rejections reach the error handler,
 * and the request/response members listed below.
 *
 * Keeping the real route files unmodified is the whole point: business rules, RBAC,
 * validation and audit logging are the same code on both hosts, so the Node test suite
 * covers the Android app too.
 */

export type NextFunction = (err?: unknown) => void;

export type UploadedFile = {
  buffer: Uint8Array;
  originalname: string;
  mimetype: string;
  size: number;
  fieldname: string;
};

export type ShimRequest = {
  method: string;
  url: string;
  /** Path within the currently mounted router (Express semantics). */
  path: string;
  originalUrl: string;
  baseUrl: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  headers: Record<string, string>;
  cookies: Record<string, string>;
  ip: string;
  secure: boolean;
  file?: UploadedFile;
  user?: unknown;
  sessionToken?: string;
  /** Raw request body, before express.json(); multer's shim reads this too. */
  rawBody?: Uint8Array;
  header(name: string): string | undefined;
  get(name: string): string | undefined;
};

export type CookieOptions = {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'lax' | 'strict' | 'none' | boolean;
  maxAge?: number;
  expires?: Date;
  path?: string;
};

export type ShimResponse = {
  statusCode: number;
  locals: Record<string, unknown>;
  readonly headersSent: boolean;
  status(code: number): ShimResponse;
  json(body: unknown): ShimResponse;
  send(body: unknown): ShimResponse;
  end(body?: unknown): ShimResponse;
  setHeader(name: string, value: string | number): ShimResponse;
  getHeader(name: string): string | undefined;
  type(value: string): ShimResponse;
  cookie(name: string, value: string, options?: CookieOptions): ShimResponse;
  clearCookie(name: string, options?: CookieOptions): ShimResponse;
  download(path: string, filename?: string): ShimResponse;
  sendFile(path: string): ShimResponse;
};

/** What the worker posts back to the page. */
export type SerializedResponse = {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array | null;
};

export type Handler = (req: ShimRequest, res: ShimResponse, next: NextFunction) => unknown;
export type ErrorHandler = (
  err: unknown,
  req: ShimRequest,
  res: ShimResponse,
  next: NextFunction,
) => unknown;

type Layer = {
  kind: 'middleware' | 'route';
  method: string | null;
  regex: RegExp | null; // null = matches every path
  keys: string[];
  handlers: Handler[];
  errorHandlers: ErrorHandler[];
  router: RouterImpl | null;
};

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;

// ---------------------------------------------------------------------------
// Path patterns. The routes only use literal segments, `:param`, and the Express 5
// wildcard forms `/{*name}` (optional trailing remainder) and `*name`.
// ---------------------------------------------------------------------------

type Token = { literal: string } | { key: string; kind: 'param' | 'splat' | 'optsplat' };

function tokenize(pattern: string): Token[] {
  const tokens: Token[] = [];
  const re = /\/\{\*([A-Za-z_]\w*)\}|\*([A-Za-z_]\w*)|:([A-Za-z_]\w*)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(pattern)) !== null) {
    if (match.index > last) tokens.push({ literal: pattern.slice(last, match.index) });
    if (match[1] !== undefined) tokens.push({ key: match[1], kind: 'optsplat' });
    else if (match[2] !== undefined) tokens.push({ key: match[2], kind: 'splat' });
    else tokens.push({ key: match[3]!, kind: 'param' });
    last = match.index + match[0].length;
  }
  if (last < pattern.length) tokens.push({ literal: pattern.slice(last) });
  return tokens;
}

function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compilePattern(pattern: string, prefixOnly: boolean): { regex: RegExp; keys: string[] } {
  const keys: string[] = [];
  let source = '';
  for (const token of tokenize(pattern)) {
    if ('literal' in token) {
      source += escapeLiteral(token.literal);
      continue;
    }
    keys.push(token.key);
    source +=
      token.kind === 'optsplat' ? '(?:/(.*))?' : token.kind === 'splat' ? '(.*)' : '([^/]+)';
  }
  // a trailing slash in the pattern is not significant
  source = source.replace(/\/$/, '');
  const tail = prefixOnly ? '(?=/|$)' : '/?$';
  return { regex: new RegExp(`^${source}${tail}`), keys };
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// ---------------------------------------------------------------------------

class RouterImpl {
  readonly layers: Layer[] = [];
  private readonly paramHandlers = new Map<
    string,
    (req: ShimRequest, res: ShimResponse, next: NextFunction, value: string) => unknown
  >();

  /** Express's router.param(name, fn) — runs once per matched route carrying that param. */
  param(
    name: string,
    fn: (req: ShimRequest, res: ShimResponse, next: NextFunction, value: string) => unknown,
  ): void {
    this.paramHandlers.set(name, fn);
  }

  use(...args: unknown[]): void {
    const pattern = typeof args[0] === 'string' ? (args[0] as string) : null;
    const entries = (typeof args[0] === 'string' ? args.slice(1) : args) as unknown[];
    const matchesAll = pattern === null || pattern === '/';
    const compiled = matchesAll
      ? { regex: null, keys: [] as string[] }
      : compilePattern(pattern, true);

    for (const entry of entries) {
      if (isRouterHandle(entry)) {
        this.layers.push({
          kind: 'middleware',
          method: null,
          regex: compiled.regex,
          keys: compiled.keys,
          handlers: [],
          errorHandlers: [],
          router: entry.__router,
        });
        continue;
      }
      const fn = entry as Handler | ErrorHandler;
      const isErrorHandler = fn.length === 4;
      this.layers.push({
        kind: 'middleware',
        method: null,
        regex: compiled.regex,
        keys: compiled.keys,
        handlers: isErrorHandler ? [] : [fn as Handler],
        errorHandlers: isErrorHandler ? [fn as ErrorHandler] : [],
        router: null,
      });
    }
  }

  addRoute(method: string, pattern: string, handlers: Handler[]): void {
    const { regex, keys } = compilePattern(pattern, false);
    this.layers.push({
      kind: 'route',
      method,
      regex,
      keys,
      handlers,
      errorHandlers: [],
      router: null,
    });
  }

  /** Walk the layer stack. `pathname` is relative to this router's mount point. */
  handle(
    req: ShimRequest,
    res: ShimResponse,
    pathname: string,
    baseUrl: string,
    done: NextFunction,
  ): void {
    let index = 0;
    const savedParams = req.params;

    const next: NextFunction = (err?: unknown) => {
      const layer = this.layers[index];
      index += 1;
      if (!layer) {
        req.params = savedParams;
        done(err);
        return;
      }

      // An error travelling down the stack may only be caught by a 4-arg handler.
      if (err !== undefined) {
        if (layer.errorHandlers.length === 0) {
          next(err);
          return;
        }
        runMaybeAsync(() => layer.errorHandlers[0]!(err, req, res, next), next);
        return;
      }
      if (layer.errorHandlers.length > 0) {
        next();
        return;
      }
      if (layer.method && layer.method !== req.method.toLowerCase()) {
        next();
        return;
      }

      const match = layer.regex ? layer.regex.exec(pathname) : null;
      if (layer.regex && !match) {
        next();
        return;
      }

      const params: Record<string, string> = { ...savedParams };
      layer.keys.forEach((key, i) => {
        const value = match?.[i + 1];
        if (value !== undefined) params[key] = decode(value);
      });
      req.params = params;

      if (layer.router) {
        const consumed = match?.[0] ?? '';
        const remainder = pathname.slice(consumed.length) || '/';
        const previousPath = req.path;
        req.baseUrl = baseUrl + consumed;
        req.path = remainder;
        layer.router.handle(req, res, remainder, req.baseUrl, (subErr) => {
          req.baseUrl = baseUrl;
          req.path = previousPath;
          req.params = savedParams;
          next(subErr);
        });
        return;
      }

      // route layer: param handlers first, then the declared handler chain
      const chain: Handler[] = [];
      if (layer.kind === 'route') {
        for (const key of layer.keys) {
          const paramFn = this.paramHandlers.get(key);
          const value = params[key];
          if (paramFn && value !== undefined) {
            chain.push((r, s, n) => paramFn(r, s, n, value));
          }
        }
      }
      chain.push(...layer.handlers);

      let i = 0;
      const step: NextFunction = (stepErr?: unknown) => {
        if (stepErr !== undefined) {
          next(stepErr);
          return;
        }
        const handler = chain[i];
        i += 1;
        if (!handler) {
          next();
          return;
        }
        runMaybeAsync(() => handler(req, res, step), next);
      };
      step();
    };

    next();
  }
}

/** Express 5 forwards rejected promises from handlers to the error handler. */
function runMaybeAsync(run: () => unknown, next: NextFunction): void {
  let result: unknown;
  try {
    result = run();
  } catch (err) {
    next(err ?? new Error('Handler threw'));
    return;
  }
  if (result && typeof (result as Promise<unknown>).catch === 'function') {
    void (result as Promise<unknown>).catch((err: unknown) =>
      next(err ?? new Error('Handler rejected')),
    );
  }
}

// ---------------------------------------------------------------------------

export type RouterHandle = {
  __router: RouterImpl;
  param(
    name: string,
    fn: (req: ShimRequest, res: ShimResponse, next: NextFunction, value: string) => unknown,
  ): RouterHandle;
  use(...args: unknown[]): RouterHandle;
} & Record<(typeof METHODS)[number], (pattern: string, ...handlers: Handler[]) => RouterHandle>;

export type Router = RouterHandle;

function isRouterHandle(value: unknown): value is RouterHandle {
  return !!value && typeof value === 'object' && '__router' in (value as object);
}

export function Router(): RouterHandle {
  const impl = new RouterImpl();
  const handle = {
    __router: impl,
    param: (name: string, fn: Parameters<RouterImpl['param']>[1]) => {
      impl.param(name, fn);
      return handle;
    },
    use: (...args: unknown[]) => {
      impl.use(...args);
      return handle;
    },
  } as RouterHandle;
  for (const method of METHODS) {
    handle[method] = (pattern: string, ...handlers: Handler[]) => {
      impl.addRoute(method, pattern, handlers);
      return handle;
    };
  }
  return handle;
}

// ---------------------------------------------------------------------------
// Request / response objects
// ---------------------------------------------------------------------------

export type RequestInput = {
  method: string;
  url: string;
  headers?: Record<string, string>;
  rawBody?: Uint8Array;
  file?: UploadedFile;
  ip?: string;
};

export function createRequest(input: RequestInput): ShimRequest {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    headers[key.toLowerCase()] = value;
  }
  const questionMark = input.url.indexOf('?');
  const pathname = questionMark === -1 ? input.url : input.url.slice(0, questionMark);
  const query: Record<string, string> = {};
  if (questionMark !== -1) {
    for (const [key, value] of new URLSearchParams(input.url.slice(questionMark + 1))) {
      query[key] = value;
    }
  }
  const req: ShimRequest = {
    method: input.method.toUpperCase(),
    url: input.url,
    path: pathname,
    originalUrl: input.url,
    baseUrl: '',
    params: {},
    query,
    body: undefined,
    headers,
    cookies: {},
    ip: input.ip ?? '127.0.0.1',
    secure: true,
    rawBody: input.rawBody,
    file: input.file,
    header: (name: string) => headers[name.toLowerCase()],
    get: (name: string) => headers[name.toLowerCase()],
  };
  return req;
}

export function createResponse(): { res: ShimResponse; sent: Promise<SerializedResponse> } {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let finished = false;
  let resolveSent!: (value: SerializedResponse) => void;
  const sent = new Promise<SerializedResponse>((resolve) => {
    resolveSent = resolve;
  });

  const finish = (body: Uint8Array | null): void => {
    if (finished) return;
    finished = true;
    resolveSent({ status: statusCode, headers, body });
  };

  const res: ShimResponse = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(value: number) {
      statusCode = value;
    },
    locals: {},
    get headersSent() {
      return finished;
    },
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(body: unknown) {
      if (!headers['content-type']) headers['content-type'] = 'application/json; charset=utf-8';
      finish(new TextEncoder().encode(JSON.stringify(body ?? null)));
      return res;
    },
    send(body: unknown) {
      if (body === undefined || body === null) {
        finish(null);
      } else if (body instanceof Uint8Array) {
        if (!headers['content-type']) headers['content-type'] = 'application/octet-stream';
        finish(body);
      } else if (typeof body === 'string') {
        if (!headers['content-type']) headers['content-type'] = 'text/html; charset=utf-8';
        finish(new TextEncoder().encode(body));
      } else {
        return res.json(body);
      }
      return res;
    },
    end(body?: unknown) {
      return res.send(body ?? null);
    },
    setHeader(name: string, value: string | number) {
      headers[name.toLowerCase()] = String(value);
      return res;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    type(value: string) {
      headers['content-type'] = value.includes('/') ? value : `application/${value}`;
      return res;
    },
    cookie(name: string, value: string, options: CookieOptions = {}) {
      const parts = [`${name}=${value}`, `Path=${options.path ?? '/'}`];
      if (options.httpOnly) parts.push('HttpOnly');
      if (options.secure) parts.push('Secure');
      if (options.sameSite) {
        const mode = options.sameSite === true ? 'Strict' : String(options.sameSite);
        parts.push(`SameSite=${mode.charAt(0).toUpperCase()}${mode.slice(1)}`);
      }
      if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge / 1000)}`);
      if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
      headers['set-cookie'] = parts.join('; ');
      return res;
    },
    clearCookie(name: string, options: CookieOptions = {}) {
      return res.cookie(name, '', { ...options, maxAge: 0 });
    },
    download() {
      // Only the Node host serves files from disk; on Android backups are exported
      // natively (see client/src/local/native-ops.ts).
      return res.status(501).json({ error: 'Not available on this device.' });
    },
    sendFile() {
      return res.status(501).json({ error: 'Not available on this device.' });
    },
  };
  return { res, sent };
}

// ---------------------------------------------------------------------------
// The application object
// ---------------------------------------------------------------------------

export type ShimApp = RouterHandle & {
  disable(setting: string): ShimApp;
  set(setting: string, value: unknown): ShimApp;
  /** Run one request to completion and return the serialized response. */
  handleRequest(input: RequestInput): Promise<SerializedResponse>;
};

function createApplication(): ShimApp {
  const app = Router() as unknown as ShimApp;
  const settings: Record<string, unknown> = {};
  app.disable = (setting: string) => {
    settings[setting] = false;
    return app;
  };
  app.set = (setting: string, value: unknown) => {
    settings[setting] = value;
    return app;
  };
  app.handleRequest = async (input: RequestInput): Promise<SerializedResponse> => {
    const req = createRequest(input);
    const { res, sent } = createResponse();
    app.__router.handle(req, res, req.path, '', (err) => {
      if (res.headersSent) return;
      if (err !== undefined) {
        console.error('[in-app server] unhandled error', err);
        res.status(500).json({ error: 'Internal server error' });
      } else {
        res.status(404).json({ error: 'Not found' });
      }
    });
    return sent;
  };
  return app;
}

// ---------------------------------------------------------------------------
// express.json() — the only body parser app.core mounts.
// ---------------------------------------------------------------------------

function json(options: { limit?: string } = {}): Handler {
  const limitBytes = parseLimit(options.limit ?? '100kb');
  return (req, _res, next) => {
    const type = req.headers['content-type'] ?? '';
    if (!type.includes('application/json') || !req.rawBody || req.rawBody.byteLength === 0) {
      if (req.body === undefined) req.body = {};
      next();
      return;
    }
    if (req.rawBody.byteLength > limitBytes) {
      next(Object.assign(new Error('request entity too large'), { status: 413 }));
      return;
    }
    try {
      req.body = JSON.parse(new TextDecoder().decode(req.rawBody));
    } catch {
      next(Object.assign(new SyntaxError('Malformed JSON body'), { status: 400 }));
      return;
    }
    next();
  };
}

function parseLimit(limit: string): number {
  const match = /^(\d+(?:\.\d+)?)(kb|mb|gb|b)?$/i.exec(limit.trim());
  if (!match) return 100 * 1024;
  const size = Number(match[1]);
  const unit = (match[2] ?? 'b').toLowerCase();
  const factor = unit === 'gb' ? 1 << 30 : unit === 'mb' ? 1 << 20 : unit === 'kb' ? 1024 : 1;
  return Math.round(size * factor);
}

/** Never used in-app (Capacitor serves the bundle) — present so app.core compiles. */
function staticFiles(): Handler {
  return (_req, _res, next) => next();
}

const express = Object.assign(createApplication, {
  json,
  Router,
  static: staticFiles,
  urlencoded:
    () =>
    ((_req: ShimRequest, _res: ShimResponse, next: NextFunction) => next()) as Handler,
});

export default express;
