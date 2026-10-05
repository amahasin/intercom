import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  desktopCapturer,
  Menu,
  MessageChannelMain,
  nativeImage,
  nativeTheme,
  Notification,
  powerMonitor,
  safeStorage,
  screen,
  shell,
  Tray,
  utilityProcess,
  type UtilityProcess,
} from 'electron';
import { badgeImage } from './badge.ts';
import { parseLaunchArgs } from './args.ts';
import { checkFirewall, fixFirewall, type FirewallFindings } from './firewall.ts';
import type { CoreToMain, HostEvent, HostRequest, MainToCore } from './host-protocol.ts';
import { APP_ORIGIN, hardenSession, registerAppScheme, serveRenderer } from './security.ts';

interface ScreenSourceInfo {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  thumbnail: string;
}

const TITLE_BAR_HEIGHT = 48;
/** Away after 5 minutes without keyboard or mouse input (plan section 6). */
const IDLE_AFTER_SECONDS = 5 * 60;
const IDLE_POLL_MS = 15_000;

const launch = parseLaunchArgs(process.argv, process.env);
const profileDir = join(launch.dataRoot, launch.profile);
mkdirSync(profileDir, { recursive: true });

// Per-profile Chromium data: lets `--profile=alice` and `--profile=bob` run side by side,
// and makes the single-instance lock (keyed on userData) per profile.
app.setPath('userData', join(profileDir, 'chromium'));
app.setPath('sessionData', join(profileDir, 'chromium'));
app.setAppUserModelId('OfficeMesh.Desktop');
registerAppScheme();
// Calls: offer real host addresses as ICE candidates. Chromium otherwise hides them behind
// mDNS names, which some office networks do not resolve (plan section 9: host candidates).
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
if (launch.fakeMedia) {
  // Tests: a synthetic camera (moving pattern) and microphone (beeps), no device prompts.
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
}

let mainWindow: BrowserWindow | undefined;
let core: UtilityProcess | undefined;
let quitting = false;
let tray: Tray | undefined;
let unread = 0;
const filesDir = join(launch.dataRoot, 'files');
/** Started by Windows at sign-in: stay in the tray until the user opens the window. */
const startHidden = process.argv.includes('--hidden');
/** Live toasts, kept referenced so their events still fire. */
const toasts = new Map<string, Notification>();

if (!app.requestSingleInstanceLock({ profile: launch.profile })) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(onReady, (err: unknown) => {
    console.error('startup failed', err);
    app.exit(1);
  });
}

function onReady(): void {
  hardenSession();
  serveRenderer(join(__dirname, '..', 'renderer'), filesDir);
  core = startCore();
  mainWindow = createMainWindow();
  createTray();
  exposeTestHooks();
  watchSystemState();
  void refreshFirewallStatus();
}

/** Idle, lock, sleep and wake drive presence and beacons in the core. */
function watchSystemState(): void {
  let idle = false;
  const poll = () => {
    const nowIdle = powerMonitor.getSystemIdleTime() >= IDLE_AFTER_SECONDS;
    if (nowIdle !== idle) {
      idle = nowIdle;
      postToCore({ kind: 'system', idle });
    }
  };
  setInterval(poll, IDLE_POLL_MS).unref();
  powerMonitor.on('lock-screen', () => postToCore({ kind: 'system', locked: true }));
  powerMonitor.on('unlock-screen', () => postToCore({ kind: 'system', locked: false }));
  powerMonitor.on('suspend', () => postToCore({ kind: 'power', event: 'suspend' }));
  powerMonitor.on('resume', () => postToCore({ kind: 'power', event: 'resume' }));
}

async function refreshFirewallStatus(): Promise<void> {
  postToCore({ kind: 'host-network', firewall: 'checking', publicNetwork: false });
  let findings: FirewallFindings;
  switch (launch.firewallOverride) {
    case 'ok':
      findings = { firewall: 'ok', publicNetwork: false };
      break;
    case 'missing':
      findings = { firewall: 'missing', publicNetwork: false };
      break;
    case 'public':
      findings = { firewall: 'ok', publicNetwork: true };
      break;
    default:
      findings = await checkFirewall();
  }
  postToCore({ kind: 'host-network', ...findings });
}

/** Screens and windows the user may share, with thumbnails for the picker. */
async function screenSources(): Promise<ScreenSourceInfo[]> {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: false,
  });
  return sources
    .filter((s) => !s.name.startsWith('OfficeMesh'))
    .map((s) => ({
      id: s.id,
      name: s.name.slice(0, 300),
      kind: s.id.startsWith('screen:') ? 'screen' : 'window',
      thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
    }));
}

let borderWindow: BrowserWindow | undefined;

/**
 * A click-through coloured frame around the screen being shared (plan section 9). It is
 * excluded from capture, so viewers do not see it.
 */
async function showShareBorder(sourceId: string | null): Promise<void> {
  borderWindow?.destroy();
  borderWindow = undefined;
  if (!sourceId?.startsWith('screen:')) return;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 0, height: 0 },
  });
  const displayId = sources.find((s) => s.id === sourceId)?.display_id;
  const display =
    screen.getAllDisplays().find((d) => String(d.id) === displayId) ?? screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    ...display.bounds,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true);
  win.setContentProtection(true);
  const html =
    '<html><body style="margin:0;height:100vh;box-sizing:border-box;border:4px solid #e3008c;background:transparent"></body></html>';
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  win.showInactive();
  borderWindow = win;
}

async function handleHostRequest(request: HostRequest): Promise<void> {
  try {
    if (request.op === 'screen-sources') {
      postToCore({ kind: 'host-res', id: request.id, ok: true, data: await screenSources() });
      return;
    }
    if (request.op === 'fix-firewall') {
      if (!launch.firewallOverride) await fixFirewall();
      await refreshFirewallStatus();
    } else {
      // Windows Settings > Network & internet, where the network profile type is set.
      await shell.openExternal('ms-settings:network-status');
    }
    postToCore({ kind: 'host-res', id: request.id, ok: true });
  } catch (err) {
    await refreshFirewallStatus();
    postToCore({
      kind: 'host-res',
      id: request.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
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
    else if (message.kind === 'host-req') void handleHostRequest(message);
    else if (message.kind !== 'status') handleHostEvent(message);
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
    network: {
      ...(launch.discoveryPort !== undefined && { discoveryPort: launch.discoveryPort }),
      ...(launch.linkPort !== undefined && { linkPort: launch.linkPort }),
      loopbackOnly: launch.loopbackOnly,
    },
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

function showWindow(): void {
  if (!mainWindow) mainWindow = createMainWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray(): void {
  const icon = nativeImage
    .createFromPath(join(__dirname, 'icon.png'))
    .resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('OfficeMesh');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open OfficeMesh', click: showWindow },
      { type: 'separator' },
      { label: 'Quit OfficeMesh', click: () => app.quit() },
    ]),
  );
  tray.on('click', showWindow);
}

function setUnread(count: number): void {
  unread = count;
  tray?.setToolTip(count > 0 ? `OfficeMesh: ${count} unread` : 'OfficeMesh');
  if (!mainWindow) return;
  if (count > 0) mainWindow.setOverlayIcon(badgeImage(count), `${count} unread messages`);
  else mainWindow.setOverlayIcon(null, '');
}

const recordedToasts: Array<{ id: string; convId: string; title: string; body: string }> = [];

function showToast(t: Extract<HostEvent, { kind: 'notify' }>['toast']): void {
  if (!app.isPackaged)
    recordedToasts.push({ id: t.id, convId: t.convId, title: t.title, body: t.body });
  if (!Notification.isSupported()) return;
  toasts.get(t.id)?.close();
  // An incoming call: no reply box; clicking brings up the window, which shows Accept.
  const n = new Notification({
    title: t.title,
    body: t.body,
    hasReply: !t.call,
    ...(!t.call && { replyPlaceholder: 'Reply' }),
    urgency: t.urgent ? 'critical' : 'normal',
    timeoutType: t.urgent ? 'never' : 'default',
  });
  n.on('reply', (details) => {
    postToCore({ kind: 'toast-action', convId: t.convId, reply: details.reply });
  });
  n.on('click', () => {
    showWindow();
    if (!t.call) postToCore({ kind: 'toast-action', convId: t.convId, target: t.target });
  });
  n.on('close', () => toasts.delete(t.id));
  toasts.set(t.id, n);
  n.show();
}

function handleHostEvent(event: HostEvent): void {
  switch (event.kind) {
    case 'notify':
      showToast(event.toast);
      return;
    case 'badge':
      setUnread(event.count);
      return;
    case 'open-path':
      void shell.openPath(event.path);
      return;
    case 'show-in-folder':
      shell.showItemInFolder(event.path);
      return;
    case 'snip':
      // Windows Snipping Tool; the user pastes the result into the compose box.
      void shell.openExternal('ms-screenclip:');
      return;
    case 'screen-border':
      void showShareBorder(event.sourceId).catch((err: unknown) =>
        console.warn('share border failed', err),
      );
      return;
    case 'start-with-windows':
      // Only an installed build registers itself; a dev build would register electron.exe.
      if (app.isPackaged)
        app.setLoginItemSettings({ openAtLogin: event.enabled, args: ['--hidden'] });
      return;
  }
}

/**
 * Development and test builds only: let end-to-end tests see toasts and act on them,
 * since Playwright cannot click Windows notifications.
 */
function exposeTestHooks(): void {
  if (app.isPackaged) return;
  (globalThis as Record<string, unknown>)['__officemeshTest'] = {
    toasts: () => recordedToasts,
    replyToToast: (convId: string, reply: string) =>
      postToCore({ kind: 'toast-action', convId, reply }),
    windowVisible: () => mainWindow?.isVisible() ?? false,
    hideWindow: () => mainWindow?.hide(),
    unread: () => unread,
  };
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
      // Calls keep their media flowing and their heartbeats on time while hidden in the tray.
      backgroundThrottling: false,
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

  // Closing the window keeps OfficeMesh running in the tray; Quit is in the tray menu.
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
  win.once('ready-to-show', () => {
    if (!startHidden) win.show();
    if (unread > 0) setUnread(unread);
  });
  // Tests: a drawn test pattern stands in for the camera (see the call engine).
  void win.loadURL(`${APP_ORIGIN}/index.html${launch.fakeMedia ? '?synthetic-camera=1' : ''}`);
  return win;
}

app.on('window-all-closed', () => {
  // Windows are only destroyed when quitting; the tray keeps the app alive otherwise.
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
