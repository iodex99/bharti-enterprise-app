/**
 * Create the Android release signing keystore, plus the four values CI needs as secrets.
 *
 *   node scripts/make-keystore.mjs [outputDir]
 *
 * Android only upgrades an installed app in place when the new APK is signed with the
 * SAME key, so this key is created once and then kept forever. Losing it means no future
 * release can ever update the app on a device that already has it — the only way forward
 * would be uninstall + reinstall, which erases that device's data.
 *
 * The password is generated here and written to a file rather than printed, so it does
 * not end up in a terminal scrollback or a chat log. Nothing is written inside the
 * repository: a signing key must never be committed.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] ?? path.join(repoRoot, '..', 'bharti-signing'));

if (outDir.startsWith(repoRoot + path.sep)) {
  console.error(`Refusing to write a signing key inside the repository (${outDir}).`);
  process.exit(1);
}

/** keytool ships with any JRE or JDK; Android Studio bundles one too. */
function findKeytool() {
  const candidates = [];
  if (process.env.JAVA_HOME) candidates.push(path.join(process.env.JAVA_HOME, 'bin', 'keytool.exe'));
  candidates.push(
    'C:/Program Files/Java/jre-1.8/bin/keytool.exe',
    'C:/Program Files/Android/Android Studio/jbr/bin/keytool.exe',
    '/usr/bin/keytool',
  );
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  for (const root of ['C:/Program Files/Java', 'C:/Program Files/Eclipse Adoptium']) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root)) {
      const candidate = path.join(root, entry, 'bin', 'keytool.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return 'keytool'; // hope it is on PATH
}

const ALIAS = 'bharti';
const keystorePath = path.join(outDir, 'bharti-release.keystore');

if (fs.existsSync(keystorePath)) {
  console.error(
    `A keystore already exists at ${keystorePath}.\n` +
      'Refusing to overwrite it — replacing a signing key breaks upgrades for every device\n' +
      'that already has the app installed. Delete it by hand only if you are certain.',
  );
  process.exit(1);
}

// url-safe so it survives copy/paste into the GitHub secrets form without escaping
const password = crypto.randomBytes(24).toString('base64url');

fs.mkdirSync(outDir, { recursive: true });

const keytool = findKeytool();
console.log(`[keystore] using ${keytool}`);

execFileSync(
  keytool,
  [
    '-genkeypair',
    '-noprompt',
    // PKCS12 is the standard format modern JDKs (CI runs 21) read natively.
    '-storetype', 'PKCS12',
    '-keystore', keystorePath,
    '-alias', ALIAS,
    '-keyalg', 'RSA',
    '-keysize', '2048',
    '-validity', '10950', // ~30 years; an expired key cannot sign an update
    '-dname', 'CN=Bharti Enterprises, O=Bharti Enterprises, C=IN',
    '-storepass', password,
    '-keypass', password,
  ],
  { stdio: ['ignore', 'inherit', 'inherit'] },
);

const base64 = fs.readFileSync(keystorePath).toString('base64');
fs.writeFileSync(path.join(outDir, 'keystore.b64'), base64);

const instructions = `BHARTI ENTERPRISES — ANDROID SIGNING KEY
=========================================

KEEP THIS FOLDER SAFE AND BACKED UP (Google Drive, a USB stick, anywhere but only here).
If this key is lost, no future release can update the app on a device that already has
it installed — the only way forward is uninstall + reinstall, which ERASES that device's
data. There is no way to recover or reissue it.

Add these four repository secrets at:
  https://github.com/iodex99/bharti-enterprise-app/settings/secrets/actions

  1. ANDROID_KEYSTORE_BASE64
     The entire contents of keystore.b64 (next to this file). It is one very long line —
     open it, select all, copy.

  2. ANDROID_KEYSTORE_PASSWORD
     ${password}

  3. ANDROID_KEY_ALIAS
     ${ALIAS}

  4. ANDROID_KEY_PASSWORD
     ${password}

(2 and 4 are deliberately the same: a PKCS12 keystore uses one password for both.)

Created: ${new Date().toISOString()}
Keystore: ${keystorePath}
Validity: 30 years
`;

fs.writeFileSync(path.join(outDir, 'SECRETS.txt'), instructions);

console.log(`\n[keystore] created ${keystorePath}`);
console.log(`[keystore] next steps + the four secret values are in:\n            ${path.join(outDir, 'SECRETS.txt')}`);
console.log('[keystore] the password is NOT printed here on purpose — read it from that file.');
