/**
 * Package a release zip for the self-update pipeline.
 *
 * Usage: node scripts/package-release.mjs <version> [--out dist-release] [--notes "..."]
 * Requires `npm run build` to have produced server/dist and client/dist first.
 *
 * Output layout inside the zip (extracted to releases/<vVERSION>/ on the office machine):
 *   server/dist/index.js(+map)   bundled app (npm deps external)
 *   server/package.json          (type: module — required for ESM resolution)
 *   client-dist/                 built SPA
 *   node_modules/                production deps, exact lockfile versions, built on THIS os/arch
 *   package.json                 minimal root manifest
 *   version.json                 { version, sha, builtAt, notes }
 */
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const version = (args[0] ?? '').replace(/^v/, '');
if (!version) {
  console.error('usage: node scripts/package-release.mjs <version> [--out dir] [--notes "..."]');
  process.exit(1);
}
const outDir = path.resolve(repoRoot, argValue('--out') ?? 'dist-release');
const notes = argValue('--notes') ?? '';

function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function run(cmd, cwd) {
  execSync(cmd, { cwd: cwd ?? repoRoot, stdio: 'inherit' });
}

const serverDist = path.join(repoRoot, 'server', 'dist', 'index.js');
const clientDist = path.join(repoRoot, 'client', 'dist', 'index.html');
if (!fs.existsSync(serverDist) || !fs.existsSync(clientDist)) {
  console.error('Build outputs missing — run `npm run build` first.');
  process.exit(1);
}

const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'bharti-staging-'));
console.log(`staging in ${staging}`);

// 1. app code
fs.cpSync(path.join(repoRoot, 'server', 'dist'), path.join(staging, 'server', 'dist'), {
  recursive: true,
});
fs.copyFileSync(
  path.join(repoRoot, 'server', 'package.json'),
  path.join(staging, 'server', 'package.json'),
);
fs.cpSync(path.join(repoRoot, 'client', 'dist'), path.join(staging, 'client-dist'), {
  recursive: true,
});

// 2. production node_modules with exact lockfile versions:
//    recreate the workspace manifests in a temp dir and `npm ci --omit=dev` there.
const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bharti-install-'));
fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(installDir, 'package.json'));
fs.copyFileSync(path.join(repoRoot, 'package-lock.json'), path.join(installDir, 'package-lock.json'));
for (const ws of ['server', 'client']) {
  fs.mkdirSync(path.join(installDir, ws), { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, ws, 'package.json'),
    path.join(installDir, ws, 'package.json'),
  );
}
console.log('installing production dependencies (npm ci --omit=dev)…');
run('npm ci --omit=dev --ignore-scripts=false --no-audit --no-fund', installDir);

// Drop workspace self-links (junctions pointing outside the zip) — nothing imports them.
fs.rmSync(path.join(installDir, 'node_modules', '@bharti'), { recursive: true, force: true });
fs.cpSync(path.join(installDir, 'node_modules'), path.join(staging, 'node_modules'), {
  recursive: true,
  verbatimSymlinks: false,
});
fs.rmSync(installDir, { recursive: true, force: true });

// 3. manifests
fs.writeFileSync(
  path.join(staging, 'package.json'),
  JSON.stringify({ name: 'bharti-enterprise-app', version, private: true, type: 'module' }, null, 2),
);
fs.writeFileSync(
  path.join(staging, 'version.json'),
  JSON.stringify(
    {
      version,
      sha: process.env.GITHUB_SHA ?? 'local',
      builtAt: new Date().toISOString(),
      notes,
    },
    null,
    2,
  ),
);

// 4. zip + checksum
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const zipName = `bharti-app-v${version}.zip`;
const zipPath = path.join(outDir, zipName);
console.log(`zipping -> ${zipPath}`);
if (process.platform === 'win32') {
  // Explicit System32 path: PATH may resolve `tar` to Git's GNU tar, which cannot write zips.
  const bsdtar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  run(`"${bsdtar}" -a -cf "${zipPath}" -C "${staging}" .`);
} else {
  run(`cd "${staging}" && zip -qry "${zipPath}" .`);
}
const hash = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
fs.writeFileSync(path.join(outDir, 'checksums.txt'), `${hash}  ${zipName}\n`);
fs.rmSync(staging, { recursive: true, force: true });

const sizeMb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
console.log(`done: ${zipName} (${sizeMb} MB), sha256=${hash}`);
