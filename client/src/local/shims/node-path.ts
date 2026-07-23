/**
 * POSIX-only `node:path` for the in-app server. Paths inside the WebView runtime are
 * synthetic (there is no real filesystem), so only the pure string algebra is needed.
 */

function normalizeParts(parts: string[], allowAboveRoot: boolean): string[] {
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (allowAboveRoot) out.push('..');
      continue;
    }
    out.push(part);
  }
  return out;
}

export function normalize(input: string): string {
  const isAbsolutePath = input.startsWith('/');
  const trailing = input.length > 1 && input.endsWith('/');
  const parts = normalizeParts(input.split('/'), !isAbsolutePath);
  let result = parts.join('/');
  if (!result && !isAbsolutePath) result = '.';
  if (result && trailing) result += '/';
  return isAbsolutePath ? `/${result}` : result;
}

export function join(...segments: string[]): string {
  const joined = segments.filter((s) => s.length > 0).join('/');
  return joined ? normalize(joined) : '.';
}

export function resolve(...segments: string[]): string {
  let resolved = '';
  let isAbsolutePath = false;
  for (let i = segments.length - 1; i >= 0 && !isAbsolutePath; i -= 1) {
    const segment = segments[i]!;
    if (!segment) continue;
    resolved = resolved ? `${segment}/${resolved}` : segment;
    isAbsolutePath = segment.startsWith('/');
  }
  if (!isAbsolutePath) resolved = `/${resolved}`;
  const parts = normalizeParts(resolved.split('/'), false);
  return parts.length > 0 ? `/${parts.join('/')}` : '/';
}

export function dirname(input: string): string {
  const normalized = input.replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  if (index === -1) return '.';
  if (index === 0) return '/';
  return normalized.slice(0, index);
}

export function basename(input: string, ext?: string): string {
  const normalized = input.replace(/\/+$/, '');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  if (ext && base.endsWith(ext) && base !== ext) return base.slice(0, -ext.length);
  return base;
}

export function extname(input: string): string {
  const base = basename(input);
  const index = base.lastIndexOf('.');
  return index <= 0 ? '' : base.slice(index);
}

export function isAbsolute(input: string): boolean {
  return input.startsWith('/');
}

export function relative(from: string, to: string): string {
  const fromParts = resolve(from).split('/').filter(Boolean);
  const toParts = resolve(to).split('/').filter(Boolean);
  let shared = 0;
  while (shared < fromParts.length && shared < toParts.length && fromParts[shared] === toParts[shared]) {
    shared += 1;
  }
  return [...fromParts.slice(shared).map(() => '..'), ...toParts.slice(shared)].join('/');
}

export const sep = '/';
export const delimiter = ':';

const path = {
  normalize,
  join,
  resolve,
  dirname,
  basename,
  extname,
  isAbsolute,
  relative,
  sep,
  delimiter,
  posix: null as unknown,
};
path.posix = path;

export default path;
