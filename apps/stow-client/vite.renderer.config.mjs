import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// @electron-forge/plugin-vite provides the base renderer config.
// This file adds the React plugin and overrides the root to point to the renderer source.
export default defineConfig({
  plugins: [react()],
  root: 'src/renderer',
  build: {
    // The Forge Vite plugin packages the project-root .vite directory. With
    // root set to src/renderer, Vite would otherwise emit into
    // src/renderer/.vite and the packaged app would have no renderer files.
    outDir: '../../.vite/renderer/main_window',
  },
});
