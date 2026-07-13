import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(here, 'src'),
      '@shared': path.resolve(here, '../shared/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // changeOrigin:false keeps the browser's Host header (localhost:5173) so it
      // matches the Origin header — the server's CSRF checkOrigin guard requires
      // Origin host === Host. In production Express serves client+API same-origin,
      // so this split only exists in dev.
      '/api': { target: 'http://localhost:8787', changeOrigin: false },
      '/uploads': { target: 'http://localhost:8787', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
