import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Android shell configuration.
 *
 * The shell is deliberately thin: it hosts a WebView, and everything else — the UI, the
 * server, the database — lives in the web bundle it serves. That is what makes one-tap
 * updates possible, because a new bundle can replace all of it without Android having to
 * install anything.
 *
 * The server URL stays `https://localhost` on every device and across every update. The
 * database lives in that origin's private storage, so swapping the bundle underneath it
 * cannot reach the data.
 */
const config: CapacitorConfig = {
  appId: 'com.bhartienterprises.app',
  appName: 'Bharti Enterprises',
  webDir: 'client/dist-app',
  android: {
    // https (not http) keeps the origin a secure context, which OPFS storage requires.
    allowMixedContent: false,
  },
  server: {
    androidScheme: 'https',
    hostname: 'localhost',
  },
};

export default config;
