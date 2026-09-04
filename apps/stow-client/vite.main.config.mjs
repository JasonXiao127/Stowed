import { defineConfig } from 'vite';
import { builtinModules } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    {
      name: 'copy-local-modules',
      enforce: 'post',
      closeBundle() {
        // Copy local source modules into .vite/build/ so that
        // require('./download'), require('./ipc/*'), etc. resolve correctly.
        const srcDir = path.join(__dirname, 'src', 'main');
        const outDir = path.join(__dirname, '.vite', 'build');

        const filesToCopy = [
          'download.js',
          'metadata.js',
          'binaries.js',
        ];

        for (const file of filesToCopy) {
          const src = path.join(srcDir, file);
          const dest = path.join(outDir, file);
          if (fs.existsSync(src)) {
            fs.copyFileSync(src, dest);
            console.log(`  Copied ${file} to .vite/build/`);
          }
        }

        // Copy ipc/ directory
        const ipcSrc = path.join(srcDir, 'ipc');
        const ipcDest = path.join(outDir, 'ipc');
        if (fs.existsSync(ipcSrc)) {
          fs.mkdirSync(ipcDest, { recursive: true });
          const ipcFiles = fs.readdirSync(ipcSrc);
          for (const file of ipcFiles) {
            fs.copyFileSync(path.join(ipcSrc, file), path.join(ipcDest, file));
          }
          console.log(`  Copied ipc/ to .vite/build/`);
        }
      },
    },
  ],
});