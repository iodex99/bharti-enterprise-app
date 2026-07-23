/**
 * The admin account the app creates for itself on a brand-new device.
 *
 * The password is generated once and exists nowhere else — so it is kept on the device
 * (not in sessionStorage, which is discarded when the app is closed) until it has been
 * changed. Losing it before the first sign-in would leave the device with no way in.
 */

const KEY = 'bharti.initialAdmin';

export type InitialAdmin = { username: string; password: string };

export function rememberInitialAdmin(admin: InitialAdmin): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(admin));
  } catch {
    /* no storage — the password is still shown on this run */
  }
}

export function readInitialAdmin(): InitialAdmin | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<InitialAdmin>;
    return parsed.username && parsed.password
      ? { username: parsed.username, password: parsed.password }
      : null;
  } catch {
    return null;
  }
}

/** Called once the password has actually been changed — it is no longer valid or needed. */
export function clearInitialAdmin(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}
