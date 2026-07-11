/**
 * Demo-mode entrypoint: identical app, but pointed at the separate demo database
 * (data-demo/). Run `npm run seed:demo` first. Real data is never touched.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.DATA_DIR ??= path.join(repoRoot, 'data-demo');
process.env.UPDATE_POLL_MINUTES ??= '0'; // demos don't need update banners

await import('./index');
