import { Capacitor, WebView } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Preferences } from '@capacitor/preferences';
import { Share } from '@capacitor/share';

/**
 * Everything the app needs from the device it is installed on, behind one interface.
 *
 * There are two implementations: the real Android one (Capacitor plugins) and a browser
 * one. The browser implementation is not a stub for convenience — it is what lets the
 * whole update flow, including the poisoned-release rollback, be exercised by the
 * automated browser tests instead of only by hand on a phone.
 */

export type BundleRecord = { version: string; path: string };

export type BundleState = {
  /** The bundle currently serving, or null when running the one inside the APK. */
  active: BundleRecord | null;
  /** What to fall back to if the active bundle fails to start. */
  previous: BundleRecord | null;
  /** A bundle that has been activated but has not yet booted successfully. */
  pending: (BundleRecord & { attempts: number; startedAt: string }) | null;
};

const EMPTY_STATE: BundleState = { active: null, previous: null, pending: null };

export interface DeviceShell {
  readonly kind: 'android' | 'browser';
  /** Android versionCode of the installed APK — decides if a web bundle is enough. */
  nativeVersion(): Promise<number>;
  readBundleState(): Promise<BundleState>;
  writeBundleState(state: BundleState): Promise<void>;
  /** Unpack a verified bundle to durable storage and return its base path. */
  writeBundle(version: string, files: Map<string, Uint8Array>): Promise<string>;
  removeBundle(path: string): Promise<void>;
  /** Point the app at a bundle path ('' = the one shipped inside the APK). */
  setActiveBundlePath(path: string): Promise<void>;
  restart(): void;
  /** Save a file where the user can reach it (Downloads/Documents) and return its URI. */
  saveUserFile(name: string, bytes: Uint8Array, mime: string): Promise<{ uri: string }>;
  shareFile(uri: string, title: string): Promise<void>;
  /** Hand an APK to Android's package installer (user confirms). */
  openExternal(url: string): Promise<void>;
  /** Private storage for pre-update safety copies. */
  writePrivateFile(name: string, bytes: Uint8Array): Promise<void>;
}

const STATE_KEY = 'bharti.bundles';
const BUNDLE_ROOT = 'bundles';

// -- shared helpers ----------------------------------------------------------

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function parseState(raw: string | null | undefined): BundleState {
  if (!raw) return { ...EMPTY_STATE };
  try {
    const parsed = JSON.parse(raw) as Partial<BundleState>;
    return {
      active: parsed.active ?? null,
      previous: parsed.previous ?? null,
      pending: parsed.pending ?? null,
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

// -- Android -----------------------------------------------------------------

class AndroidShell implements DeviceShell {
  readonly kind = 'android' as const;

  async nativeVersion(): Promise<number> {
    try {
      const info = await App.getInfo();
      const build = Number(info.build);
      return Number.isFinite(build) ? build : 1;
    } catch {
      return 1;
    }
  }

  async readBundleState(): Promise<BundleState> {
    const { value } = await Preferences.get({ key: STATE_KEY });
    return parseState(value);
  }

  async writeBundleState(state: BundleState): Promise<void> {
    await Preferences.set({ key: STATE_KEY, value: JSON.stringify(state) });
  }

  async writeBundle(version: string, files: Map<string, Uint8Array>): Promise<string> {
    const dir = `${BUNDLE_ROOT}/${version}`;
    // A half-written bundle from an interrupted attempt must never be activated.
    await this.removeRelative(dir);
    await Filesystem.mkdir({ path: dir, directory: Directory.Data, recursive: true });
    for (const [name, bytes] of files) {
      await Filesystem.writeFile({
        path: `${dir}/${name}`,
        directory: Directory.Data,
        data: toBase64(bytes),
        recursive: true,
      });
    }
    const { uri } = await Filesystem.getUri({ path: dir, directory: Directory.Data });
    return uri.replace(/^file:\/\//, '');
  }

  private async removeRelative(path: string): Promise<void> {
    try {
      await Filesystem.rmdir({ path, directory: Directory.Data, recursive: true });
    } catch {
      /* not there — fine */
    }
  }

  async removeBundle(path: string): Promise<void> {
    const marker = `/${BUNDLE_ROOT}/`;
    const index = path.indexOf(marker);
    if (index === -1) return;
    await this.removeRelative(path.slice(index + 1));
  }

  async setActiveBundlePath(path: string): Promise<void> {
    await WebView.setServerBasePath({ path });
    await WebView.persistServerBasePath();
  }

  restart(): void {
    window.location.reload();
  }

  async saveUserFile(name: string, bytes: Uint8Array, _mime: string): Promise<{ uri: string }> {
    // Documents is user-visible through the Files app and the share sheet.
    const result = await Filesystem.writeFile({
      path: name,
      directory: Directory.Documents,
      data: toBase64(bytes),
      recursive: true,
    });
    return { uri: result.uri };
  }

  async shareFile(uri: string, title: string): Promise<void> {
    await Share.share({ title, url: uri, dialogTitle: title });
  }

  async openExternal(url: string): Promise<void> {
    window.open(url, '_system');
  }

  async writePrivateFile(name: string, bytes: Uint8Array): Promise<void> {
    await Filesystem.writeFile({
      path: `backups/${name}`,
      directory: Directory.Data,
      data: toBase64(bytes),
      recursive: true,
    });
  }
}

// -- Browser (development + automated tests) ---------------------------------

class BrowserShell implements DeviceShell {
  readonly kind = 'browser' as const;

  private readonly bundles = new Map<string, Map<string, Uint8Array>>();

  async nativeVersion(): Promise<number> {
    const override = localStorage.getItem('bharti.nativeVersion');
    return override ? Number(override) : 1;
  }

  async readBundleState(): Promise<BundleState> {
    return parseState(localStorage.getItem(STATE_KEY));
  }

  async writeBundleState(state: BundleState): Promise<void> {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  }

  async writeBundle(version: string, files: Map<string, Uint8Array>): Promise<string> {
    const path = `/bundles/${version}`;
    this.bundles.set(path, files);
    // Record the file list so tests (and a curious developer) can see what landed.
    localStorage.setItem(`bharti.bundle:${path}`, JSON.stringify([...files.keys()].sort()));
    return path;
  }

  async removeBundle(path: string): Promise<void> {
    this.bundles.delete(path);
    localStorage.removeItem(`bharti.bundle:${path}`);
  }

  async setActiveBundlePath(path: string): Promise<void> {
    localStorage.setItem('bharti.serverBasePath', path);
  }

  restart(): void {
    window.location.reload();
  }

  async saveUserFile(name: string, bytes: Uint8Array, mime: string): Promise<{ uri: string }> {
    const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return { uri: url };
  }

  async shareFile(): Promise<void> {
    /* the browser download above already handed the file to the user */
  }

  async openExternal(url: string): Promise<void> {
    window.open(url, '_blank', 'noopener');
  }

  async writePrivateFile(name: string, bytes: Uint8Array): Promise<void> {
    localStorage.setItem(`bharti.privateFile:${name}`, String(bytes.byteLength));
  }
}

let shell: DeviceShell | null = null;

export function getShell(): DeviceShell {
  if (!shell) {
    shell = Capacitor.isNativePlatform() ? new AndroidShell() : new BrowserShell();
  }
  return shell;
}

/** Tests install their own shell to drive the update flow deterministically. */
export function setShell(next: DeviceShell | null): void {
  shell = next;
}

export { Directory, Encoding, Filesystem };
