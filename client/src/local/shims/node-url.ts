/**
 * `node:url` shim. Only fileURLToPath is used (to locate the migrations directory
 * relative to a module); in the bundled app the path is synthetic and the fs shim
 * resolves it by suffix.
 */
export function fileURLToPath(url: string | URL): string {
  const text = typeof url === 'string' ? url : url.href;
  const withoutScheme = text.replace(/^file:\/\//, '').replace(/^https?:\/\/[^/]+/, '');
  return withoutScheme || '/app';
}

export function pathToFileURL(path: string): URL {
  return new URL(`file://${path.startsWith('/') ? path : `/${path}`}`);
}

export default { fileURLToPath, pathToFileURL };
