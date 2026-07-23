/**
 * Package an Android release: the web bundle the running app installs by itself, plus
 * the manifest that tells it what to expect.
 *
 *   node scripts/package-app-bundle.mjs <version> [apkPath]
 *
 * Produces in dist-release/:
 *   web-bundle-v<version>.zip   the whole app (UI + server + migrations)
 *   app-manifest.json           version, sha256s, and the minimum native shell version
 *   checksums.txt               sha256sum-style, for anyone verifying by hand
 *
 * minNativeVersion comes from android/native-version.txt — the release run number at
 * which the native shell last changed. A device whose APK is older than that cannot run
 * the bundle and is told to install the APK instead (see shared/src/update.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const bundleDir = path.join(repoRoot, 'client', 'dist-app');
const outDir = path.join(repoRoot, 'dist-release');

const version = process.argv[2];
const apkPath = process.argv[3];
if (!version) {
  console.error('usage: node scripts/package-app-bundle.mjs <version> [apkPath]');
  process.exit(1);
}

if (!fs.existsSync(path.join(bundleDir, 'index.html'))) {
  console.error(`No built bundle at ${bundleDir} — run "npm run build:app" first.`);
  process.exit(1);
}

// The bundle states its own version so the updater can refuse a mismatched download.
fs.writeFileSync(path.join(bundleDir, 'version.json'), JSON.stringify({ version }, null, 2));

function collect(dir, prefix = '') {
  const files = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(files, collect(full, rel));
    else files[rel] = new Uint8Array(fs.readFileSync(full));
  }
  return files;
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

const files = collect(bundleDir);
const bundleName = `web-bundle-v${version}.zip`;
const zip = Buffer.from(zipSync(files, { level: 6 }));

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, bundleName), zip);

let nativeVersion = 1;
try {
  const raw = fs.readFileSync(path.join(repoRoot, 'android', 'native-version.txt'), 'utf8');
  const parsed = Number(raw.trim());
  if (Number.isFinite(parsed) && parsed > 0) nativeVersion = parsed;
} catch {
  /* default 1 — no native shell change has been recorded yet */
}

let apk = null;
if (apkPath && fs.existsSync(apkPath)) {
  const apkBytes = fs.readFileSync(apkPath);
  // A debug-signed APK installs and runs, but Android will refuse to upgrade it in place
  // from a properly signed release — and switching keys means uninstalling, which erases
  // the device's data. Name it so nobody can install one by accident.
  const apkName =
    process.env.APK_UNSIGNED === '1'
      ? `bharti-v${version}-UNSIGNED-do-not-install.apk`
      : `bharti-v${version}.apk`;
  fs.writeFileSync(path.join(outDir, apkName), apkBytes);
  apk = { name: apkName, sha256: sha256(apkBytes), sizeBytes: apkBytes.length };
}

const manifest = {
  version,
  webBundle: { name: bundleName, sha256: sha256(zip), sizeBytes: zip.length },
  apk,
  minNativeVersion: nativeVersion,
  notes: process.env.RELEASE_NOTES ?? '',
};
fs.writeFileSync(path.join(outDir, 'app-manifest.json'), JSON.stringify(manifest, null, 2));

const checksums = [
  `${manifest.webBundle.sha256}  ${bundleName}`,
  ...(apk ? [`${apk.sha256}  ${apk.name}`] : []),
].join('\n');
fs.writeFileSync(path.join(outDir, 'checksums.txt'), `${checksums}\n`);

console.log(`[package] ${bundleName} (${(zip.length / 1024).toFixed(0)} kB), ${Object.keys(files).length} files`);
console.log(`[package] minNativeVersion=${nativeVersion}${apk ? `, apk ${apk.name}` : ', no apk'}`);
