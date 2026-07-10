import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * appRoot resolves to the repo root in dev (server/src/../..) AND to the
 * release root in production (server/dist/../..) — both layouts put this
 * file two levels below the root.
 */
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readVersion(): string {
  try {
    const raw = fs.readFileSync(path.join(appRoot, 'version.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    if (parsed.version) return parsed.version;
  } catch {
    // no version.json in dev checkouts
  }
  return '0.0.0-dev';
}

function resolveClientDist(): string | null {
  const candidates = [
    process.env.CLIENT_DIST,
    path.join(appRoot, 'client-dist'), // release zip layout
    path.join(appRoot, 'client', 'dist'), // repo layout
  ].filter((p): p is string => !!p);
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

export const config = {
  appRoot,
  env: process.env.NODE_ENV ?? 'development',
  isProduction: process.env.NODE_ENV === 'production',
  port: Number(process.env.PORT ?? 8787),
  dataDir: path.resolve(process.env.DATA_DIR ?? path.join(appRoot, 'data')),
  version: readVersion(),
  clientDist: resolveClientDist(),
};

export type Config = typeof config;
