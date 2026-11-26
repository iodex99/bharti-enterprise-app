export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const OFFICE_KEY = 'bharti.office';

/**
 * The office this browser works in (ADR-028). Operators are pinned server-side (the
 * header is ignored for them); admin/owner pick one in the header switcher. Changing it
 * reloads the app so every cached query is refetched in the new office.
 */
export function activeOfficeId(): number {
  try {
    const raw = localStorage.getItem(OFFICE_KEY);
    const parsed = raw ? Number(raw) : 1;
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
  } catch {
    return 1;
  }
}

export function switchOffice(id: number): void {
  try {
    localStorage.setItem(OFFICE_KEY, String(id));
  } catch {
    /* no storage — header falls back to office 1 */
  }
  window.location.assign('/');
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'X-Office-Id': String(activeOfficeId()),
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* non-JSON error */
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * Fetch a file (PDF statement, …) for this office, with the server's suggested name.
 * Same office header and error handling as JSON calls.
 */
async function fetchFile(path: string): Promise<{ blob: Blob; fileName: string }> {
  const res = await fetch(path, { headers: { 'X-Office-Id': String(activeOfficeId()) } });
  if (!res.ok) {
    let message = `Download failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* non-JSON error */
    }
    throw new ApiError(res.status, message);
  }
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(disposition);
  return { blob: await res.blob(), fileName: match?.[1] ?? 'download' };
}

export const api = {
  file: fetchFile,
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
