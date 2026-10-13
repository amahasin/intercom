/**
 * Call windows. Every call (and every meeting) gets a window of its own, so the main window
 * stays free for chat while a call runs, and an incoming call rings in a small always-on-top
 * window in the corner of the screen. The core tells main which calls exist (`calls` host
 * event); main opens, focuses and closes windows to match. Each window is a renderer of
 * its own with its own port to the core; the call window runs the media for its call.
 */
import { BrowserWindow, ipcMain, nativeImage, nativeTheme, screen } from 'electron';
import { join } from 'node:path';

export interface HostCallInfo {
  callId: string;
  ringing: boolean;
  media: 'audio' | 'video';
  name: string;
}

export interface CallWindowDeps {
  /** `officemesh://app` */
  origin: string;
  preload: string;
  /** Directory holding icon.ico. */
  assets: string;
  /** Give a new window its port to the core. */
  attach(win: BrowserWindow): void;
  /** The user closed a call window: the call is over for them. */
  windowClosed(callId: string): void;
  /** Bring the main window to the front. */
  showMain(): void;
  titleBarSymbolColor(): string;
  /** Tests: the synthetic camera flag, passed on to the page. */
  syntheticCamera: boolean;
}

/** How long a window whose call is gone gets to say "Call ended" before it is closed for it. */
const LINGER_MS = 8_000;
const INCOMING_WIDTH = 380;
const INCOMING_MARGIN = 16;

export class CallWindows {
  private readonly calls = new Map<string, BrowserWindow>();
  private readonly incoming = new Map<string, BrowserWindow>();
  private readonly lingering = new Map<string, NodeJS.Timeout>();
  private readonly deps: CallWindowDeps;
  private known = new Map<string, HostCallInfo>();

  constructor(deps: CallWindowDeps) {
    this.deps = deps;
    nativeTheme.on('updated', () => {
      for (const win of this.calls.values())
        if (!win.isDestroyed()) win.setTitleBarOverlay({ symbolColor: deps.titleBarSymbolColor() });
    });
    // Messages from the call windows themselves. Each is accepted only from its own kind.
    ipcMain.on('window:close', (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win && this.owns(win)) win.close();
    });
    ipcMain.on('window:fit', (event, height: unknown) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || typeof height !== 'number' || ![...this.incoming.values()].includes(win)) return;
      this.place(win, Math.max(120, Math.min(520, Math.round(height))));
    });
    ipcMain.on('window:show-main', () => this.deps.showMain());
    ipcMain.on('window:attention', (event) =>
      this.attention(BrowserWindow.fromWebContents(event.sender)),
    );
    ipcMain.on('window:focus-call', (_event, callId: unknown) => {
      if (typeof callId !== 'string') return;
      const win = this.calls.get(callId);
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    });
  }

  private owns(win: BrowserWindow): boolean {
    return [...this.calls.values(), ...this.incoming.values()].includes(win);
  }

  /** Is this one of the call windows (the only windows that may drive remote control)? */
  isCallWindow(win: BrowserWindow | null): boolean {
    return win !== null && [...this.calls.values()].includes(win);
  }

  /** Make a call window impossible to miss (somebody asks to control the shared screen). */
  attention(win: BrowserWindow | null): void {
    if (!win || !this.isCallWindow(win)) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.flashFrame(true);
  }

  /** The call window for a call, for tests and for focusing. */
  callWindow(callId: string): BrowserWindow | undefined {
    return this.calls.get(callId);
  }

  /** Open and close windows so each call has the right one. */
  sync(list: HostCallInfo[]): void {
    const now = new Map(list.map((c) => [c.callId, c]));
    for (const c of list) {
      const timer = this.lingering.get(c.callId);
      if (timer) clearTimeout(timer);
      this.lingering.delete(c.callId);
      if (c.ringing) {
        if (!this.incoming.has(c.callId)) this.openIncoming(c);
        continue;
      }
      // It was ringing and has been answered: the small window gives way to the call window.
      const ring = this.incoming.get(c.callId);
      if (ring) {
        this.incoming.delete(c.callId);
        ring.destroy();
      }
      const win = this.calls.get(c.callId);
      if (!win) this.openCall(c);
    }
    // Calls that are over: their window shows how it ended and closes itself; this makes sure.
    for (const id of this.known.keys()) {
      if (now.has(id)) continue;
      for (const map of [this.calls, this.incoming]) {
        const win = map.get(id);
        if (!win || this.lingering.has(id)) continue;
        this.lingering.set(
          id,
          setTimeout(() => {
            this.lingering.delete(id);
            if (!win.isDestroyed()) win.close();
          }, LINGER_MS),
        );
      }
    }
    this.known = now;
  }

  private openCall(info: HostCallInfo): void {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const width = Math.min(1180, display.width - 80);
    const height = Math.min(760, display.height - 80);
    const win = new BrowserWindow({
      width,
      height,
      x: display.x + Math.round((display.width - width) / 2),
      y: display.y + Math.round((display.height - height) / 2),
      minWidth: 560,
      minHeight: 420,
      show: false,
      title: `InterCom - ${info.name}`,
      icon: nativeImage.createFromPath(join(this.deps.assets, 'icon.ico')),
      backgroundMaterial: 'mica',
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#00000000',
        symbolColor: this.deps.titleBarSymbolColor(),
        height: 40,
      },
      webPreferences: this.prefs(),
    });
    this.calls.set(info.callId, win);
    this.load(win, 'call', info.callId);
    win.once('ready-to-show', () => {
      win.show();
      win.focus();
    });
    win.on('closed', () => {
      if (this.calls.get(info.callId) === win) this.calls.delete(info.callId);
      // Closing the window leaves the call (a no-op when it already ended).
      this.deps.windowClosed(info.callId);
    });
  }

  private openIncoming(info: HostCallInfo): void {
    const win = new BrowserWindow({
      width: INCOMING_WIDTH,
      height: 200,
      show: false,
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: true,
      title: `InterCom - ${info.name}`,
      icon: nativeImage.createFromPath(join(this.deps.assets, 'icon.ico')),
      backgroundColor: '#00000000',
      transparent: true,
      webPreferences: this.prefs(),
    });
    // Above full-screen apps and other always-on-top windows: a call must be seen.
    win.setAlwaysOnTop(true, 'screen-saver');
    this.incoming.set(info.callId, win);
    this.place(win, 200);
    this.load(win, 'incoming', info.callId);
    // Shown without taking the keyboard from whatever the user is typing in.
    win.once('ready-to-show', () => win.showInactive());
    win.on('closed', () => {
      if (this.incoming.get(info.callId) === win) this.incoming.delete(info.callId);
    });
  }

  /** Bottom-right corner of the screen the user is working on, above the taskbar. */
  private place(win: BrowserWindow, height: number): void {
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    win.setBounds({
      width: INCOMING_WIDTH,
      height,
      x: area.x + area.width - INCOMING_WIDTH - INCOMING_MARGIN,
      y: area.y + area.height - height - INCOMING_MARGIN,
    });
  }

  private prefs(): Electron.WebPreferences {
    return {
      preload: this.deps.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // Media and heartbeats must keep flowing when the window is covered or minimised.
      backgroundThrottling: false,
    };
  }

  private load(win: BrowserWindow, role: 'call' | 'incoming', callId: string): void {
    win.webContents.on('did-finish-load', () => this.deps.attach(win));
    const synthetic = this.deps.syntheticCamera ? '&synthetic-camera=1' : '';
    void win.loadURL(`${this.deps.origin}/index.html?role=${role}&call=${callId}${synthetic}`);
  }

  closeAll(): void {
    for (const t of this.lingering.values()) clearTimeout(t);
    for (const win of [...this.calls.values(), ...this.incoming.values()]) win.destroy();
  }
}
