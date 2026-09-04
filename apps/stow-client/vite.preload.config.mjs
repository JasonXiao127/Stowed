import { defineConfig } from 'vite';

// The @electron-forge/plugin-vite generates its own preload config internally.
// This file exists to allow user overrides, but leaving it empty/minimal means
// the Forge plugin will use its default config which handles the build correctly.
export default defineConfig({});