/**
 * Static host for the Android app bundle, plus a mock release feed.
 *
 * The Android bundle has no backend — everything runs inside the page — so serving the
 * built files is enough to exercise the real app in a browser, which is what the
 * app-mode E2E suite does. Chromium's engine here is the same one the Android System
 * WebView uses, including OPFS.
 *
 * The mock feed lets the update flow be tested end to end without GitHub: it serves a
 * release manifest and real bundle zips, including deliberately broken ones so the
 * verification and rollback paths are proven rather than assumed.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', 'client', 'dist-app');
const PORT = Number(process.env.APP_PORT ?? 8789);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function readBundleFiles() {
  const files = {};
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, rel);
      else files[rel] = new Uint8Array(fs.readFileSync(full));
    }
  };
  walk(root, '');
  return files;
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/** version: what version.json inside the bundle claims. */
function buildBundle({ version, corrupt = false, dropEntryScript = false }) {
  const files = readBundleFiles();
  files['version.json'] = new TextEncoder().encode(JSON.stringify({ version }));
  if (dropEntryScript) {
    // Remove the script index.html points at — the updater must refuse to activate this.
    const html = new TextDecoder().decode(files['index.html']);
    const match = /(?:src|href)="\/?([^"]+\.js)"/.exec(html);
    if (match) delete files[match[1]];
  }
  const zip = zipSync(files, { level: 0 });
  return corrupt ? Buffer.concat([Buffer.from(zip), Buffer.from('tampered')]) : Buffer.from(zip);
}

const cache = new Map();
function bundleFor(kind) {
  if (!cache.has(kind)) {
    const spec = {
      good: { version: '9.9.9' },
      broken: { version: '9.9.8', dropEntryScript: true },
      corrupt: { version: '9.9.7' },
    }[kind];
    const bytes = buildBundle(spec);
    // For the 'corrupt' case the manifest advertises the hash of the clean zip while the
    // served bytes differ, which is exactly what a damaged download looks like.
    const served = kind === 'corrupt' ? Buffer.concat([bytes, Buffer.from('x')]) : bytes;
    cache.set(kind, { bytes: served, sha256: sha256(bytes), version: spec.version });
  }
  return cache.get(kind);
}

function sendJson(res, body, status = 200) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = decodeURIComponent(url.pathname);

  // ---- mock release feed ---------------------------------------------------
  const feedMatch = /^\/mock-feed\/(good|broken|corrupt)\/(latest\.json|app-manifest\.json|bundle\.zip)$/.exec(
    pathname,
  );
  if (feedMatch) {
    const [, kind, file] = feedMatch;
    const bundle = bundleFor(kind);
    const base = `http://localhost:${PORT}/mock-feed/${kind}`;
    if (file === 'latest.json') {
      return sendJson(res, {
        tag_name: bundle.version,
        body: 'Mock release for the update drill',
        published_at: new Date().toISOString(),
        assets: [
          { name: 'app-manifest.json', browser_download_url: `${base}/app-manifest.json` },
          { name: 'web-bundle.zip', browser_download_url: `${base}/bundle.zip` },
        ],
      });
    }
    if (file === 'app-manifest.json') {
      return sendJson(res, {
        version: bundle.version,
        webBundle: {
          name: 'web-bundle.zip',
          sha256: bundle.sha256,
          sizeBytes: bundle.bytes.length,
        },
        apk: null,
        minNativeVersion: 1,
        notes: 'Mock release for the update drill',
      });
    }
    res.writeHead(200, {
      'content-type': 'application/zip',
      'access-control-allow-origin': '*',
      'content-length': bundle.bytes.length,
    });
    return res.end(bundle.bytes);
  }

  // ---- static bundle -------------------------------------------------------
  let filePath = path.join(root, pathname);
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(root, 'index.html'); // SPA fallback
  }
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
});

server.listen(PORT, () => {
  console.log(`[app-server] serving ${root} on http://localhost:${PORT}`);
});
