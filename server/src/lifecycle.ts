/**
 * Graceful shutdown / restart protocol.
 * Exit codes understood by the supervisor: 42 = apply staged update, 43 = boot failure.
 */

type Cleanup = () => void | Promise<void>;

const cleanups: Cleanup[] = [];
let exitRequested = false;

/** Register cleanup (DB close, cron stop…). Runs LIFO on shutdown. */
export function onShutdown(fn: Cleanup): void {
  cleanups.push(fn);
}

export async function runCleanups(): Promise<void> {
  for (const fn of [...cleanups].reverse()) {
    try {
      await fn();
    } catch (err) {
      console.error('[lifecycle] cleanup failed:', err);
    }
  }
}

let exitImpl: (code: number) => void = (code) => {
  void runCleanups().finally(() => process.exit(code));
};

/** index.ts installs the real implementation (drains HTTP first). */
export function setExitImpl(fn: (code: number) => void): void {
  exitImpl = fn;
}

export function gracefulExit(code: number): void {
  if (exitRequested) return;
  exitRequested = true;
  exitImpl(code);
}

export const EXIT_APPLY_UPDATE = 42;
export const EXIT_BOOT_FAILURE = 43;
