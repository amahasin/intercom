// Builds the four bundles of the desktop app with Vite:
//   dist/main/main.cjs        Electron main process
//   dist/main/core-host.cjs   utility process running @officemesh/core
//   dist/preload/preload.cjs  sandboxed preload (must be CommonJS)
//   dist/renderer/            React UI
import { copyFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(appRoot, 'dist');
const mode = process.env.NODE_ENV === 'development' ? 'development' : 'production';

/** A CommonJS bundle for a Node-flavoured Electron context; every dependency is inlined except `external`. */
function nodeBundle({ entry, outDir, fileName, external }) {
  return {
    configFile: false,
    root: appRoot,
    mode,
    logLevel: 'warn',
    define: { 'process.env.NODE_ENV': JSON.stringify(mode) },
    ssr: { noExternal: true, external },
    build: {
      ssr: resolve(appRoot, entry),
      outDir: resolve(dist, outDir),
      emptyOutDir: false,
      target: 'node24',
      minify: mode === 'production',
      sourcemap: mode === 'development',
      reportCompressedSize: false,
      rolldownOptions: {
        external,
        output: {
          format: 'cjs',
          entryFileNames: fileName,
          codeSplitting: false,
          comments: { legal: false },
        },
      },
    },
  };
}

rmSync(dist, { recursive: true, force: true });

await build(
  nodeBundle({
    entry: 'main/src/main.ts',
    outDir: 'main',
    fileName: 'main.cjs',
    external: ['electron'],
  }),
);
await build(
  nodeBundle({
    entry: 'main/src/core-host.ts',
    outDir: 'main',
    fileName: 'core-host.cjs',
    external: ['better-sqlite3'],
  }),
);
await build(
  nodeBundle({
    entry: 'preload/src/preload.ts',
    outDir: 'preload',
    fileName: 'preload.cjs',
    external: ['electron'],
  }),
);
await build({
  configFile: false,
  root: resolve(appRoot, 'renderer'),
  base: './',
  mode,
  logLevel: 'warn',
  plugins: [react()],
  build: {
    outDir: resolve(dist, 'renderer'),
    emptyOutDir: true,
    target: 'chrome150',
    minify: mode === 'production',
    sourcemap: mode === 'development',
    reportCompressedSize: false,
    chunkSizeWarningLimit: 4096,
    rolldownOptions: { output: { comments: { legal: false } } },
  },
});

// Tray icon, loaded by the main process at runtime.
copyFileSync(resolve(appRoot, 'build', 'icon.png'), resolve(dist, 'main', 'icon.png'));

console.log(`desktop build (${mode}) written to ${dist}`);
