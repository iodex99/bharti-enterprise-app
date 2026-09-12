/**
 * "Is anyone actually working right now?" — the signal automatic updates wait on.
 *
 * Deliberately dependency-free (no fs, no DB, no config) so the auth middleware can
 * import it without dragging the Node-only updater into the Android bundle, which
 * compiles the same middleware through the shims in client/src/local/shims.
 */

let lastActivityAt = Date.now();

/** Called by the auth middleware for every request a signed-in person actually made. */
export function recordUserActivity(): void {
  lastActivityAt = Date.now();
}

/** Seconds since the last deliberate user request. */
export function idleSeconds(): number {
  return Math.max(0, Math.round((Date.now() - lastActivityAt) / 1000));
}

/** Test seam: pretend the office has been quiet for this long. */
export function setLastActivityForTest(at: number): void {
  lastActivityAt = at;
}
