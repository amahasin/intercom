import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  MessageChannelMain,
  nativeTheme,
  safeStorage,
  utilityProcess,
  type UtilityProcess,
} from 'electron';
import { parseLaunchArgs } from './args.ts';
import type { CoreToMain, MainToCore } from './host-protocol.ts';
import { APP_ORIGIN, hardenSession, registerAppScheme, serveRenderer } from './security.ts';

const TITLE_BAR_HEIGHT = 48;

const launch = parseLaunchArgs(process.argv, process.env);
const profileDir = join(launch.dataRoot, launch.profile);
mkdirSync(profileDir, { recursive: true });

// Per-profile Chromium data: lets `--profile=alice` and `--profile=bob` run side by side,
// and makes the single-instance lock (keyed on userData) per profile.
app.setPath('userData', join(profileDir, 'chromium'));
app.setPath('sessionData', join(profileDir, 'chromium'));
app.setAppUserModelId('OfficeMesh.Desktop');
registerAppScheme();

let mainWindow: BrowserWindow | undefined;
let core: UtilityProcess | undefined;
let quitting = false;

if (!app.requestSingleInstanceLock({ profile: launch.profile })) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.whenReady().then(onReady, (err: unknown) => {
    console.error('startup failed', err);
    app.exit(1);
  });
}

function onReady(): void {
  hardenSession();
  serveRenderer(join(__dirname, '..', 'renderer'));
  core = startCore();
  mainWindow = createMainWindow();
}

function postToCore(message: MainToCore, transfer?: Electron.MessagePortMain[]): void {
  core?.postMessage(message, transfer);
}

function startCore(): UtilityProcess {
  const child = utilityProcess.fork(join(__dirname, 'core-host.cjs'), [], {
    serviceName: 'OfficeMesh Core',
    stdio: 'inherit',
  });
  child.on('message', (message: CoreToMain) => {
    if (message.kind === 'key-protect-req') handleKeyProtect(message.id, message.op, message.data);
    else if (message.kind === 'status' && message.state === 'error')
      console.error('core error:', message.message);
  });
  child.on('exit', (code) => {
    core = undefined;
    if (!quitting) console.error(`core process exited unexpectedly (code ${code})`);
  });
  child.postMessage({
    kind: 'init',
    dataDir: profileDir,
    profile: launch.profile,
    appVersion: app.getVersion(),
  } satisfies MainToCore);
  return child;
}

/** safeStorage (DPAPI on Windows) is only available in the main process. */
function handleKeyProtect(id: number, op: 'protect' | 'unprotect', data: string): void {
  try {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('safeStorage is not available');
    const bytes = Buffer.from(data, 'base64');
    const out =
      op === 'protect'
        ? safeStorage.encryptString(bytes.toString('base64'))
        : Buffer.from(safeStorage.decryptString(bytes), 'base64');
    postToCore({ kind: 'key-protect-res', id, ok: true, data: out.toString('base64') });
  } catch (err) {
    postToCore({
      kind: 'key-protect-res',
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function titleBarSymbolColor(): string {
  return nativeTheme.shouldUseDarkColors ? '#ffffff' : '#242424';
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 920,
    minHeight: 600,
    show: false,
    title: launch.profile === 'default' ? 'OfficeMesh' : `OfficeMesh (${launch.profile})`,
    backgroundMaterial: 'mica',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: titleBarSymbolColor(),
      height: TITLE_BAR_HEIGHT,
    },
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
    },
  });

  const onTheme = () => win.setTitleBarOverlay({ symbolColor: titleBarSymbolColor() });
  nativeTheme.on('updated', onTheme);
  win.on('closed', () => {
    nativeTheme.off('updated', onTheme);
    if (mainWindow === win) mainWindow = undefined;
  });

  // Every page load gets a fresh port to the core; the old one closes with the old page.
  win.webContents.on('did-finish-load', () => {
    const { port1, port2 } = new MessageChannelMain();
    postToCore({ kind: 'attach', windowId: win.id }, [port1]);
    win.webContents.postMessage('officemesh:core-port', null, [port2]);
  });

  win.once('ready-to-show', () => win.show());
  void win.loadURL(`${APP_ORIGIN}/index.html`);
  return win;
}

app.on('window-all-closed', () => {
  // The tray keeps the app alive from M2; until then closing the window quits.
  app.quit();
});

app.on('before-quit', (event) => {
  if (quitting || !core) return;
  // Let the core close its database cleanly before the process exits.
  event.preventDefault();
  quitting = true;
  const child = core;
  const timer = setTimeout(() => child.kill(), 3_000);
  child.once('exit', () => {
    clearTimeout(timer);
    app.quit();
  });
  postToCore({ kind: 'shutdown' });
});
