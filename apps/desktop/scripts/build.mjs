// Builds the four bundles of the desktop app with Vite:
//   dist/main/main.cjs        Electron main process
//   dist/main/core-host.cjs   utility process running @officemesh/core
//   dist/preload/preload.cjs  sandboxed preload (must be CommonJS)
//   dist/renderer/            React UI
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, minify } from 'vite';
import react from '@vitejs/plugin-react';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(appRoot, 'dist');
const mode = process.env.NODE_ENV === 'development' ? 'development' : 'production';

/** A CommonJS bundle for a Node-flavoured Electron context; every dependency is inlined except `external`. */
function nodeBundle({ entry, outDir, fileName, external, plugins = [] }) {
  return {
    configFile: false,
    plugins,
    root: appRoot,
    mode,
    logLevel: 'warn',
    define: {
      'process.env.NODE_ENV': JSON.stringify(mode),
      // Set when an office builds its own installers (docs/building-a-release.md); empty otherwise.
      __INTERCOM_OFFICE_UPDATE_FOLDER__: JSON.stringify(
        process.env.INTERCOM_OFFICE_UPDATE_FOLDER ?? '',
      ),
      __INTERCOM_GITHUB_REPO__: JSON.stringify(process.env.INTERCOM_GITHUB_REPO ?? ''),
    },
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

/**
 * mediasoup reads only `version` from its package.json; bundling the whole file would carry
 * its homepage, repository and funding URLs into the app (and fail the origin check).
 */
function mediasoupVersionOnly() {
  return {
    name: 'officemesh-mediasoup-version-only',
    enforce: 'pre',
    load(id) {
      if (!/[\\/]mediasoup[\\/]package\.json$/.test(id)) return null;
      const { version } = JSON.parse(readFileSync(id, 'utf8'));
      return JSON.stringify({ version });
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
    // mediasoup's JavaScript is bundled; its worker executable ships as a resource.
    external: ['better-sqlite3'],
    plugins: [mediasoupVersionOnly()],
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
/**
 * MediaPipe's vision bundle always starts a usage logger that posts to a Google endpoint
 * every minute. OfficeMesh never talks to the internet (and the session would block it
 * anyway), so the send is cut out at build time. The build fails if the code changes.
 */
const MEDIAPIPE_LOG_SEND = 'this.m.send({url:"https://odml.pa.googleapis.com/v1/log"';
function noMediapipeTelemetry() {
  return {
    name: 'officemesh-no-mediapipe-telemetry',
    transform(code, id) {
      if (!id.includes('@mediapipe') || !id.includes('vision_bundle')) return null;
      if (!code.includes(MEDIAPIPE_LOG_SEND)) {
        throw new Error(
          'MediaPipe logger not found: re-check the telemetry patch for this version',
        );
      }
      return code.replace(MEDIAPIPE_LOG_SEND, 'void 0&&this.m.send({url:""');
    },
  };
}

await build({
  configFile: false,
  root: resolve(appRoot, 'renderer'),
  base: './',
  mode,
  logLevel: 'warn',
  plugins: [react(), noMediapipeTelemetry()],
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

// The noise gate runs on the audio thread: a file of its own that the page loads as an audio worklet.
await build({
  configFile: false,
  root: resolve(appRoot, 'renderer'),
  mode,
  logLevel: 'warn',
  build: {
    outDir: resolve(dist, 'renderer'),
    emptyOutDir: false,
    target: 'chrome150',
    minify: mode === 'production',
    reportCompressedSize: false,
    lib: {
      entry: resolve(appRoot, 'renderer', 'src', 'calls', 'gate.worklet.ts'),
      formats: ['es'],
      fileName: () => 'gate-worklet.js',
    },
    rolldownOptions: { output: { comments: { legal: false } } },
  },
});

// Background blur (M5): MediaPipe's WebAssembly runtime and the selfie segmentation model,
// served from the app itself; nothing is downloaded at run time.
const mediapipe = resolve(dist, 'renderer', 'mediapipe');
mkdirSync(mediapipe, { recursive: true });
const wasmDir = resolve(appRoot, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
copyFileSync(
  resolve(wasmDir, 'vision_wasm_internal.wasm'),
  resolve(mediapipe, 'vision_wasm_internal.wasm'),
);
// The Emscripten loader ships with comments full of documentation links; drop them
// (no compression or renaming, so the code itself is unchanged).
const loader = await minify(
  'vision_wasm_internal.js',
  readFileSync(resolve(wasmDir, 'vision_wasm_internal.js'), 'utf8'),
  { compress: false, mangle: false, codegen: { removeWhitespace: false } },
);
writeFileSync(resolve(mediapipe, 'vision_wasm_internal.js'), loader.code);
copyFileSync(
  resolve(appRoot, 'assets', 'models', 'selfie_segmenter.tflite'),
  resolve(mediapipe, 'selfie_segmenter.tflite'),
);

// The built-in PDF viewer (pdf.js): the fonts, character maps and image decoders a PDF may need,
// served from the app itself. The scripting sandbox (quickjs) and the no-wasm fallbacks are left out.
{
  const from = resolve(appRoot, 'node_modules', 'pdfjs-dist');
  const to = resolve(dist, 'renderer', 'pdfjs');
  for (const folder of ['cmaps', 'standard_fonts', 'iccs'])
    cpSync(resolve(from, folder), resolve(to, folder), { recursive: true });
  mkdirSync(resolve(to, 'wasm'), { recursive: true });
  for (const file of ['jbig2.wasm', 'openjpeg.wasm', 'qcms_bg.wasm'])
    copyFileSync(resolve(from, 'wasm', file), resolve(to, 'wasm', file));
}

// Tray icon, loaded by the main process at runtime.
copyFileSync(resolve(appRoot, 'build', 'icon.png'), resolve(dist, 'main', 'icon.png'));
copyFileSync(resolve(appRoot, 'build', 'icon.ico'), resolve(dist, 'main', 'icon.ico'));

// The remote-control input helper (resources/rcinput.cs), compiled with the C# compiler that is
// part of Windows (.NET Framework 4). One AnyCPU file serves x64 and ARM64.
{
  const csc = resolve(
    process.env.SystemRoot ?? 'C:\\Windows',
    'Microsoft.NET',
    'Framework64',
    'v4.0.30319',
    'csc.exe',
  );
  if (existsSync(csc)) {
    execFileSync(
      csc,
      [
        '/nologo',
        '/optimize+',
        '/target:exe',
        `/out:${resolve(dist, 'main', 'rcinput.exe')}`,
        resolve(appRoot, 'resources', 'rcinput.cs'),
      ],
      { stdio: 'inherit' },
    );
  } else {
    console.warn('rcinput.exe was not built: the .NET Framework C# compiler was not found');
  }
}

console.log(`desktop build (${mode}) written to ${dist}`);
