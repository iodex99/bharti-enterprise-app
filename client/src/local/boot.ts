import type { BootInfo } from './protocol';

/**
 * App start-up, in order:
 *
 *   1. bundle health gate  — if the bundle installed by the last update has already
 *      failed to start once, put the previous one back and restart (updater.ts).
 *   2. in-app server       — open the database, run migrations, take over fetch.
 *   3. mark healthy        — reaching this point IS the definition of "the update worked".
 *   4. background work     — daily backup catch-up and the update poll.
 *
 * Anything that throws before step 3 leaves the pending-bundle marker in place, so the
 * next launch rolls back by itself.
 */

/** True in the Android/app build (`vite build --mode app`). */
export const IS_APP_BUILD = import.meta.env.MODE === 'app';

let info: BootInfo | null = null;

export function appBootInfo(): BootInfo | null {
  return info;
}

function showFatal(message: string): void {
  const root = document.getElementById('root');
  if (!root) return;
  root.innerHTML = `
    <div style="font-family:system-ui,sans-serif;padding:24px;max-width:640px;margin:0 auto">
      <h1 style="font-size:20px;font-weight:700;color:#b91c1c">The app could not start</h1>
      <p style="margin-top:12px;color:#374151">${message}</p>
      <p style="margin-top:12px;color:#6b7280;font-size:14px">
        Your data is stored separately and has not been changed. Close the app completely
        and open it again; if this keeps happening, reinstall the app file — the data on
        this device stays where it is.
      </p>
    </div>`;
}

export async function bootApp(): Promise<void> {
  const [
    {
      readRollbackNotice,
      guardBundleBoot,
      markBundleHealthy,
      setCurrentVersion,
      startUpdatePolling,
    },
    bridge,
    ops,
  ] = await Promise.all([import('./updater'), import('./bridge'), import('./native-ops')]);

  try {
    const decision = await guardBundleBoot();
    if (decision.action === 'rolled-back') return; // restarting into the previous bundle

    info = await bridge.startLocalServer();
    setCurrentVersion(info.version);

    // Booted far enough to serve requests — the new bundle is good.
    await markBundleHealthy();
    readRollbackNotice();

    if (info.initialAdmin) {
      // First run on this device. This password exists nowhere else, so keep it until it
      // has been changed — the sign-in screen shows it (see pages/LoginPage.tsx).
      const { rememberInitialAdmin } = await import('./first-run');
      rememberInitialAdmin(info.initialAdmin);
    }

    void ops.runDailyBackupIfDue();
    setInterval(() => void ops.runDailyBackupIfDue(), 60 * 60 * 1000);
    startUpdatePolling(30);
  } catch (err) {
    console.error('[boot]', err);
    showFatal((err as Error).message);
    throw err;
  }
}
