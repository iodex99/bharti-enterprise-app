import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const shims = path.resolve(here, 'src/local/shims');

function appVersion(): string {
  for (const candidate of [
    path.resolve(here, '..', 'version.json'),
    path.resolve(here, 'version.json'),
  ]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { version?: string };
      if (parsed.version) return parsed.version;
    } catch {
      /* not a release build */
    }
  }
  return process.env.APP_VERSION ?? '0.0.0-dev';
}

/**
 * Two build targets from one source tree:
 *
 *  - default  — the browser client that talks to the Node/Express server over HTTP.
 *  - `app`    — the Android bundle (`vite build --mode app`). There is no server, so
 *               the SERVER'S OWN CODE is compiled into a worker that runs inside the
 *               WebView: `express` and the Node builtins resolve to the shims in
 *               src/local/shims, and SQLite is the WebAssembly build.
 *
 * Aliasing rather than forking the server code is deliberate — the routes, services and
 * ledger rules stay one implementation, covered by one test suite.
 */
export default defineConfig(({ mode }) => {
  const isApp = mode === 'app';
  const version = appVersion();

  /**
   * The bundle states its own version on disk. The updater compares it against the
   * release manifest before activating a download, and the copy baked into the APK
   * needs it too — so it is written by the build, not by a later packaging step.
   */
  const stampVersion = {
    name: 'bharti-version-json',
    apply: 'build' as const,
    closeBundle() {
      if (!isApp) return;
      const target = path.resolve(here, 'dist-app', 'version.json');
      fs.writeFileSync(target, `${JSON.stringify({ version }, null, 2)}\n`);
    },
  };

  return {
    plugins: [react(), tailwindcss(), stampVersion],
    define: {
      __APP_VERSION__: JSON.stringify(version),
      // Where installed apps look for updates: a small PUBLIC releases repo, so devices
      // need no credentials while the source stays private.
      __UPDATE_FEED__: JSON.stringify(process.env.UPDATE_FEED_URL ?? ''),
    },
    resolve: {
      alias: [
        { find: '@shared', replacement: path.resolve(here, '../shared/src/index.ts') },
        { find: /^@\//, replacement: `${path.resolve(here, 'src')}/` },
        ...(isApp
          ? [
              { find: /^express$/, replacement: path.join(shims, 'express.ts') },
              { find: /^cookie-parser$/, replacement: path.join(shims, 'cookie-parser.ts') },
              { find: /^multer$/, replacement: path.join(shims, 'multer.ts') },
              { find: /^better-sqlite3$/, replacement: path.join(shims, 'better-sqlite3.ts') },
              { find: /^node:fs$/, replacement: path.join(shims, 'node-fs.ts') },
              { find: /^node:path$/, replacement: path.join(shims, 'node-path.ts') },
              { find: /^node:crypto$/, replacement: path.join(shims, 'node-crypto.ts') },
              { find: /^node:url$/, replacement: path.join(shims, 'node-url.ts') },
            ]
          : []),
      ],
    },
    // sqlite-wasm ships its own .wasm next to the module; pre-bundling breaks that URL.
    optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
    worker: { format: 'es' },
    server: {
      port: 5173,
      proxy: isApp
        ? undefined
        : {
            // changeOrigin:false keeps the browser's Host header (localhost:5173) so it
            // matches the Origin header — the server's CSRF checkOrigin guard requires
            // Origin host === Host. In production Express serves client+API same-origin,
            // so this split only exists in dev.
            '/api': { target: 'http://localhost:8787', changeOrigin: false },
            '/uploads': { target: 'http://localhost:8787', changeOrigin: false },
          },
    },
    build: {
      outDir: isApp ? 'dist-app' : 'dist',
      sourcemap: false,
      target: 'es2022',
    },
  };
});
