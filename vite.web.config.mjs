import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Web build for the Stow renderer.
 *
 * Emits a plain static bundle into dist/ that the Node web server
 * (server/index.js) serves. The React components and CSS are used as-is.
 */
export default defineConfig({
  plugins: [react()],
  root: 'src/renderer',
  base: './',
  server: {
    // Vite is only the internal dev origin that the Node web server
    // (server/index.js) proxies to. Keep it on a stable port; open the app at
    // http://localhost:5183 (the Node server), NOT Vite's own port here.
    // `host: '0.0.0.0'` lets the dev server be reached from other devices on the LAN.
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
  },
});