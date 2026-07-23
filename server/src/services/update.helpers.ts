/**
 * The update-feed helpers now live in shared/ so the Android in-app updater and the
 * Node supervisor updater parse the exact same release feed. Re-exported here because
 * this is where the server-side callers (and their tests) have always found them.
 */
export {
  expectedHashFor,
  isBusy,
  parseReleaseResponse,
  type ReleaseAsset,
  type ReleaseInfo,
  type UpdateState,
} from '@shared';
