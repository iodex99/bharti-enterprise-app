import fs from 'node:fs';
import { createApp } from './app';
import { config } from './config';

fs.mkdirSync(config.dataDir, { recursive: true });

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(
    `[bharti] v${config.version} listening on http://localhost:${config.port} (${config.env})`,
  );
});

function shutdown(signal: string) {
  console.log(`[bharti] ${signal} received, shutting down`);
  server.close(() => {
    process.exit(0);
  });
  // Do not hang forever on open keep-alive sockets.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
