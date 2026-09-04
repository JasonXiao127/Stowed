const path = require('path');

module.exports = {
  packagerConfig: {
    name: 'Stow',
    executableName: 'stow',
    asar: true,
    prune: true,
    icon: './assets/icon',
    // The Vite plugin normally keeps only .vite in the packaged app. The
    // main process still loads a few CommonJS modules at runtime, so retain
    // production dependencies and the window icon as well.
    ignore: (file) => {
      if (!file) return false;
      const normalized = file.replaceAll('\\', '/');
      return !(
        normalized === '/package.json' ||
        normalized.startsWith('/.vite') ||
        normalized.startsWith('/node_modules') ||
        normalized.startsWith('/assets')
      );
    },
    extraResource: [
      './bin',
    ],
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'stow',
        setupExe: 'Stow-Setup.exe',
        setupIcon: './assets/icon.ico',
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'linux', 'win32'],
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-vite',
      config: {
        build: [
          {
            entry: 'src/main/index.js',
            config: 'vite.main.config.mjs',
          },
          {
            entry: 'src/preload.js',
            config: 'vite.preload.config.mjs',
          },
        ],
        renderer: [
          {
            name: 'main_window',
            config: 'vite.renderer.config.mjs',
          },
        ],
      },
    },
  ],
};
