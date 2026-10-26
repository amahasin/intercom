import { execFile, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  Menu,
  MessageChannelMain,
  nativeImage,
  nativeTheme,
  Notification,
  powerMonitor,
  safeStorage,
  type Display,
  ipcMain,
  screen,
  shell,
  Tray,
  utilityProcess,
  type UtilityProcess,
} from 'electron';
import { badgeImage } from './badge.ts';
import { CallWindows } from './windows.ts';
import { RemoteInput, type RemoteTarget } from './remote-input.ts';
import { parseLaunchArgs } from './args.ts';
import { checkFirewall, fixFirewall, type FirewallFindings } from './firewall.ts';
import type {
  CoreToMain,
  FilePathResponse,
  HostEvent,
  HostRequest,
  MainToCore,
} from './host-protocol.ts';
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
/**
 * A shared folder of installers that an office may want its PCs to take updates from (it is
 * required there). Not part of the public source: an office's own build sets it (see
 * docs/building-a-release.md); it is empty in the public release.
 */
declare const __INTERCOM_OFFICE_UPDATE_FOLDER__: string | undefined;
const OFFICE_UPDATE_FOLDER =
  typeof __INTERCOM_OFFICE_UPDATE_FOLDER__ === 'string' ? __INTERCOM_OFFICE_UPDATE_FOLDER__ : '';
/** The project's GitHub repository: its releases are where the public build looks for updates. */
declare const __INTERCOM_GITHUB_REPO__: string | undefined;
const GITHUB_REPO =
  typeof __INTERCOM_GITHUB_REPO__ === 'string' && __INTERCOM_GITHUB_REPO__
    ? __INTERCOM_GITHUB_REPO__
    : 'amahasin/intercom';
const IDLE_POLL_MS = 15_000;

const launch = parseLaunchArgs(process.argv, process.env);
// Under its old name the app kept its data in %LOCALAPPDATA%\OfficeMesh: carry it over, or keep
// using it where it is if it cannot be moved (the old app may still be running).
if (launch.legacyDataRoot && existsSync(launch.legacyDataRoot) && !existsSync(launch.dataRoot)) {
  try {
    renameSync(launch.legacyDataRoot, launch.dataRoot);
  } catch {
    launch.dataRoot = launch.legacyDataRoot;
  }
}
const profileDir = join(launch.dataRoot, launch.profile);
mkdirSync(profileDir, { recursive: true });

// Per-profile Chromium data: lets `--profile=alice` and `--profile=bob` run side by side,
// and makes the single-instance lock (keyed on userData) per profile.
app.setPath('userData', join(profileDir, 'chromium'));
app.setPath('sessionData', join(profileDir, 'chromium'));
// Toasts show the name and icon of whatever shortcut carries this id. The installer's
// shortcut uses the appId; a development run gets a Start Menu shortcut of its own (below).
app.setAppUserModelId(app.isPackaged ? 'app.officemesh.desktop' : 'InterCom.Desktop');
if (process.platform === 'win32' && !app.isPackaged) {
  // Windows names a toast, and draws its taskbar icon, from the Start Menu shortcut that carries
  // the app's id; without one a toast says "Electron". A development run (and the tests and the
  // soak, which are development runs) gets a shortcut of its own, named like the app. An
  // installed InterCom's shortcut has the same name but another id: that one is never touched.
  try {
    const link = join(
      app.getPath('appData'),
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'InterCom.lnk',
    );
    let ours = true;
    if (existsSync(link)) {
      try {
        ours = shell.readShortcutLink(link).appUserModelId === 'InterCom.Desktop';
      } catch {
        ours = false;
      }
    }
    if (ours)
      shell.writeShortcutLink(link, existsSync(link) ? 'update' : 'create', {
        target: process.execPath,
        args: app.getAppPath(),
        icon: join(__dirname, 'icon.ico'),
        iconIndex: 0,
        appUserModelId: 'InterCom.Desktop',
        description: 'InterCom',
      });
  } catch {
    // Notifications then carry Windows' fallback name; nothing else depends on it.
  }
}
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
let callWindows: CallWindows | undefined;
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
  serveRenderer(join(__dirname, '..', 'renderer'), filesDir, askCoreForFile);
  core = startCore();
  callWindows = new CallWindows({
    origin: APP_ORIGIN,
    preload: join(__dirname, '..', 'preload', 'preload.cjs'),
    assets: __dirname,
    attach: attachCore,
    windowClosed: (callId) => postToCore({ kind: 'call-window-closed', callId }),
    showMain: showWindow,
    titleBarSymbolColor,
    syntheticCamera: launch.fakeMedia,
  });
  // Remote control: only a call window, only while control is granted for what is shared (a
  // whole screen or one window). The answer says whether input can now be delivered, and if
  // not why, so "allowed" never ends in nothing happening.
  ipcMain.handle('rc:state', async (event, active: unknown) => {
    const from = BrowserWindow.fromWebContents(event.sender);
    if (!callWindows?.isCallWindow(from)) return { ok: false, reason: 'not a call window' };
    controlWindow = from ?? undefined;
    const result = await remoteInput.setActive(active === true, sharedTarget(), process.pid);
    setBorderColor(result.ok && active === true ? CONTROLLED_BORDER : SHARE_BORDER);
    return result;
  });
  ipcMain.on('rc:input', (event, input: unknown) => {
    if (callWindows?.isCallWindow(BrowserWindow.fromWebContents(event.sender)))
      remoteInput.handle(input);
  });
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
      findings = await checkFirewall(process.execPath, assistHelperPath());
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
    .filter((s) => !s.name.startsWith('InterCom'))
    .map((s) => ({
      id: s.id,
      name: s.name.slice(0, 300),
      kind: s.id.startsWith('screen:') ? 'screen' : 'window',
      thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
    }));
}

let borderWindow: BrowserWindow | undefined;
/** The screen being shared (whole screens only can be controlled), and who may drive it. */
let sharedDisplay: Display | undefined;
/** The shared source (`screen:…` or `window:<hwnd>:…`) and the call window controlling it. */
let sharedSourceId: string | null = null;
let controlWindow: BrowserWindow | undefined;

/** Where remote input lands: the shared screen (physical pixels) or the shared window. */
function sharedTarget(): RemoteTarget | undefined {
  if (sharedSourceId?.startsWith('window:')) {
    const hwnd = Number(sharedSourceId.split(':')[1]);
    return Number.isFinite(hwnd) ? { hwnd } : undefined;
  }
  if (!sharedDisplay) return undefined;
  const rect = screen.dipToScreenRect(null, sharedDisplay.bounds);
  return { rect };
}

/** The compiled input helper: beside the app's other resources when installed, in dist when run from source. */
function rcinputPath(): string | undefined {
  const path = app.isPackaged
    ? join(process.resourcesPath, 'rcinput.exe')
    : join(__dirname, 'rcinput.exe');
  return existsSync(path) ? path : undefined;
}

/** The remote help helper (M6.18): next to rcinput.exe when installed, in dist when run from source. */
function assistHelperPath(): string | undefined {
  const path = app.isPackaged
    ? join(process.resourcesPath, 'intercom-assist.exe')
    : join(__dirname, 'intercom-assist.exe');
  return existsSync(path) ? path : undefined;
}

const remoteInput = new RemoteInput(rcinputPath, (e) => {
  if (e.type === 'cursor') controlWindow?.webContents.send('rc:cursor', e);
  else controlWindow?.webContents.send('rc:failed', e.reason);
});

const SHARE_BORDER = '#e3008c';
const CONTROLLED_BORDER = '#ff8c00';
function setBorderColor(color: string): void {
  void borderWindow?.webContents
    .executeJavaScript(`document.body.style.borderColor = ${JSON.stringify(color)}`)
    .catch(() => {});
}

/**
 * A click-through coloured frame around the screen being shared (plan section 9). It is
 * excluded from capture, so viewers do not see it.
 */
async function showShareBorder(sourceId: string | null): Promise<void> {
  borderWindow?.destroy();
  borderWindow = undefined;
  sharedDisplay = undefined;
  sharedSourceId = sourceId;
  remoteInput.stop();
  // A shared window has no frame drawn around it, and is controlled through its handle.
  if (!sourceId?.startsWith('screen:')) return;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 0, height: 0 },
  });
  const displayId = sources.find((s) => s.id === sourceId)?.display_id;
  const display =
    screen.getAllDisplays().find((d) => String(d.id) === displayId) ?? screen.getPrimaryDisplay();
  sharedDisplay = display;
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
  const html = `<html><body style="margin:0;height:100vh;box-sizing:border-box;border:2px solid ${SHARE_BORDER};background:transparent"></body></html>`;
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
    if (request.op === 'verify-signature') {
      const data =
        (request.path ?? null) === null && launch.asUnsignedApp && !app.isPackaged
          ? { status: 'unsigned' as const }
          : await verifySignature(request.path ?? process.execPath);
      postToCore({ kind: 'host-res', id: request.id, ok: true, data });
      return;
    }
    if (request.op === 'pick-folder') {
      const result = await dialog.showOpenDialog({
        title: 'Choose where to save received files',
        properties: ['openDirectory', 'createDirectory'],
        ...(request.path && { defaultPath: request.path }),
      });
      postToCore({
        kind: 'host-res',
        id: request.id,
        ok: true,
        data: result.canceled ? null : (result.filePaths[0] ?? null),
      });
      return;
    }
    if (request.op === 'pick-share-folder') {
      // Tests: a folder is "picked" without a dialog (never in an installed build).
      const fake = process.env['INTERCOM_FAKE_SHARE_FOLDER'];
      if (!app.isPackaged && fake) {
        postToCore({ kind: 'host-res', id: request.id, ok: true, data: fake });
        return;
      }
      const result = await dialog.showOpenDialog({
        title: 'Choose a folder to send',
        properties: ['openDirectory'],
      });
      postToCore({
        kind: 'host-res',
        id: request.id,
        ok: true,
        data: result.canceled ? null : (result.filePaths[0] ?? null),
      });
      return;
    }
    if (request.op === 'pick-profile') {
      const result = await dialog.showOpenDialog({
        title: 'Import an InterCom profile',
        properties: ['openFile'],
        filters: [{ name: 'InterCom profile', extensions: ['omprofile'] }],
      });
      postToCore({
        kind: 'host-res',
        id: request.id,
        ok: true,
        data: result.canceled ? null : (result.filePaths[0] ?? null),
      });
      return;
    }
    if (request.op === 'fix-firewall') {
      if (!launch.firewallOverride)
        await fixFirewall(process.execPath, relayWorkerBin(), assistHelperPath());
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

/**
 * The media relay worker for hosting large meetings (M6): shipped unpacked from the app
 * archive on x64 builds. ARM64 builds have none and never host.
 */
function relayWorkerBin(): string | undefined {
  if (process.arch !== 'x64') return undefined;
  const bin = app.isPackaged
    ? join(process.resourcesPath, 'relay', 'mediasoup-worker.exe')
    : join(
        app.getAppPath(),
        'node_modules',
        'mediasoup',
        'worker',
        'out',
        'Release',
        'mediasoup-worker.exe',
      );
  return existsSync(bin) ? bin : undefined;
}

/** Authenticode status and publisher of a file, for the update check. */
async function verifySignature(
  path: string,
): Promise<{ status: 'valid' | 'unsigned' | 'invalid'; publisher?: string }> {
  const quoted = `'${path.replaceAll("'", "''")}'`;
  const out = await new Promise<string>((resolve, reject) =>
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$s = Get-AuthenticodeSignature -LiteralPath ${quoted}; @{ status = [string]$s.Status; subject = [string]$s.SignerCertificate.Subject } | ConvertTo-Json -Compress`,
      ],
      { timeout: 30_000, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    ),
  );
  const r = JSON.parse(out.trim()) as { status: string; subject: string };
  if (r.status === 'Valid') return { status: 'valid', publisher: r.subject };
  if (r.status === 'NotSigned') return { status: 'unsigned' };
  return { status: 'invalid', ...(r.subject && { publisher: r.subject }) };
}

/** Where a shared picture or video lives, asked of the core (which owns the file records). */
const pendingFilePaths = new Map<number, (path: string | null) => void>();
let nextFilePathId = 1;
function askCoreForFile(sha: string, type: string): Promise<string | null> {
  if (!core) return Promise.resolve(null);
  const id = nextFilePathId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingFilePaths.delete(id);
      resolve(null);
    }, 5_000);
    pendingFilePaths.set(id, (path) => {
      clearTimeout(timer);
      resolve(path);
    });
    postToCore({ kind: 'file-path-req', id, sha, type });
  });
}
function settleFilePath(message: FilePathResponse): void {
  pendingFilePaths.get(message.id)?.(message.path);
  pendingFilePaths.delete(message.id);
}

function postToCore(message: MainToCore, transfer?: Electron.MessagePortMain[]): void {
  core?.postMessage(message, transfer);
}

function startCore(): UtilityProcess {
  const child = utilityProcess.fork(join(__dirname, 'core-host.cjs'), [], {
    serviceName: 'InterCom Core',
    stdio: 'inherit',
  });
  child.on('message', (message: CoreToMain) => {
    if (message.kind === 'key-protect-req') handleKeyProtect(message.id, message.op, message.data);
    else if (message.kind === 'file-path-res') settleFilePath(message);
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
    // Only an installed build looks at the office's share (a dev or test run has nothing to update).
    ...(app.isPackaged && OFFICE_UPDATE_FOLDER && { updateFolder: OFFICE_UPDATE_FOLDER }),
    ...(app.isPackaged && { updateRepo: GITHUB_REPO }),
    repository: GITHUB_REPO,
    network: {
      ...(launch.discoveryPort !== undefined && { discoveryPort: launch.discoveryPort }),
      ...(launch.linkPort !== undefined && { linkPort: launch.linkPort }),
      loopbackOnly: launch.loopbackOnly,
    },
    downloadsDir: launch.downloadsDir ?? app.getPath('downloads'),
    ...(launch.fakeRemoteAssist && { fakeRemoteAssist: true }),
    ...(assistHelperPath() && { assistHelper: assistHelperPath() }),
    relay: {
      ...(relayWorkerBin() && { workerBin: relayWorkerBin() }),
      ...(launch.relayScore !== undefined && { score: launch.relayScore }),
      ...(launch.relayAbove !== undefined && { meshLimit: launch.relayAbove }),
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

/** Give a window its own port to the core: every page load gets a fresh one. */
function attachCore(win: BrowserWindow): void {
  const { port1, port2 } = new MessageChannelMain();
  postToCore({ kind: 'attach', windowId: win.id }, [port1]);
  win.webContents.postMessage('officemesh:core-port', null, [port2]);
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
  tray.setToolTip('InterCom');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open InterCom', click: showWindow },
      { type: 'separator' },
      { label: 'Quit InterCom', click: () => app.quit() },
    ]),
  );
  tray.on('click', showWindow);
}

function setUnread(count: number): void {
  unread = count;
  tray?.setToolTip(count > 0 ? `InterCom: ${count} unread` : 'InterCom');
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
  // Calls never come here (the call window rings instead), so every toast takes a reply.
  const n = new Notification({
    title: t.title,
    body: t.body,
    icon: nativeImage.createFromPath(join(__dirname, 'icon.png')),
    hasReply: !t.call && !t.noReply,
    ...(!t.call && !t.noReply && { replyPlaceholder: 'Reply' }),
    urgency: t.urgent ? 'critical' : 'normal',
    timeoutType: t.urgent ? 'never' : 'default',
  });
  // One banner, one reply: Windows can raise the reply event more than once for the same text.
  let replied = false;
  n.on('reply', (details) => {
    if (replied) return;
    replied = true;
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
    case 'calls':
      callWindows?.sync(event.calls);
      return;
    case 'notify':
      showToast(event.toast);
      return;
    case 'badge':
      setUnread(event.count);
      return;
    case 'open-path':
      void shell.openPath(event.path);
      return;
    case 'run-installer':
      // The installer replaces this app: start it on its own and get out of its way. These
      // are electron-builder's update switches: silent, and start the app again afterwards.
      // The installer is run from a copy in the temp folder with its "downloaded from another
      // computer" mark removed (the mark is what makes Windows SmartScreen say "Windows protected
      // your PC"). It was checked (signature, version) where it was found, and the mark means
      // nothing for a file this office's own share handed over.
      try {
        const copy = join(app.getPath('temp'), 'InterCom-update', basename(event.path));
        mkdirSync(dirname(copy), { recursive: true });
        copyFileSync(event.path, copy);
        rmSync(`${copy}:Zone.Identifier`, { force: true });
        event.path = copy;
      } catch (err) {
        console.warn('could not prepare the installer; running it where it is', err);
      }
      spawn(event.path, ['--updated', '/S', '--force-run'], {
        detached: true,
        stdio: 'ignore',
      }).unref();
      app.quit();
      return;
    case 'relaunch':
      app.relaunch();
      app.quit();
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
    case 'theme':
      // Every window follows: the pages through `prefers-color-scheme`, the title bar through
      // the `updated` event below.
      nativeTheme.themeSource = event.theme;
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
    remoteControlActive: () => remoteInput.isActive,
    cursor: () => screen.getCursorScreenPoint(),
    sharedDisplay: () => sharedDisplay?.bounds ?? null,
    sharedTarget: () => sharedTarget() ?? null,
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
    title: launch.profile === 'default' ? 'InterCom' : `InterCom (${launch.profile})`,
    icon: nativeImage.createFromPath(join(__dirname, 'icon.ico')),
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
  win.webContents.on('did-finish-load', () => attachCore(win));

  // Closing the window keeps InterCom running in the tray; Quit is in the tray menu.
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
  callWindows?.closeAll();
  const child = core;
  const timer = setTimeout(() => child.kill(), 3_000);
  child.once('exit', () => {
    clearTimeout(timer);
    app.quit();
  });
  postToCore({ kind: 'shutdown' });
});
