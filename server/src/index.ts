import fs from 'node:fs';
import path from 'node:path';
import { createApp } from './app';
import { config } from './config';
import { closeDb, getDb } from './db/connection';
import { migrate } from './db/migrate';
import { ensureInitialAdmin } from './services/auth.service';
import { startBackupCron } from './services/backup.service';
import { EXIT_BOOT_FAILURE, onShutdown, runCleanups, setExitImpl } from './lifecycle';
import { startUpdatePolling } from './services/update.service';

fs.mkdirSync(config.dataDir, { recursive: true });

// ---- boot: migrate BEFORE binding the port; failure = exit 43 (supervisor rolls back) ----
try {
  const db = getDb();
  const applied = migrate(db, path.join(config.dataDir, 'app.db'));
  if (applied.length) console.log(`[bharti] applied migrations: ${applied.join(', ')}`);
  const admin = ensureInitialAdmin(db);
  if (admin.created) {
    const msg = `Initial admin user created — username: admin, password: ${admin.password} (must be changed at first sign-in)`;
    console.log(`[bharti] ${msg}`);
    // Also drop it in the data dir so an office installer can find it once.
    fs.writeFileSync(path.join(config.dataDir, 'initial-admin-password.txt'), msg + '\n');
  }
  onShutdown(() => closeDb());
} catch (err) {
  console.error('[bharti] BOOT FAILURE (migrations):', err);
  process.exit(EXIT_BOOT_FAILURE);
}

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(
    `[bharti] v${config.version} listening on http://localhost:${config.port} (${config.env})`,
  );
});

// Track open sockets so a restart request can drain fast without hanging on keep-alives.
const sockets = new Set<import('node:net').Socket>();
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

function drainAndExit(code: number): void {
  console.log(`[bharti] draining connections, exiting with code ${code}`);
  server.close(() => {
    void runCleanups().finally(() => process.exit(code));
  });
  setTimeout(() => {
    for (const socket of sockets) socket.destroy();
  }, 2000).unref();
  // Hard deadline: never hang the update handover.
  setTimeout(() => {
    void runCleanups().finally(() => process.exit(code));
  }, 8000).unref();
}

setExitImpl(drainAndExit);

process.on('SIGINT', () => drainAndExit(0));
process.on('SIGTERM', () => drainAndExit(0));

startUpdatePolling();
startBackupCron();
