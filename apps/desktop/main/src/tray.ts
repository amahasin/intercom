import {
  Menu,
  nativeImage,
  Tray,
  type MenuItemConstructorOptions,
  type NativeImage,
} from 'electron';
import type { ManualPresenceState, PresenceState } from '@officemesh/protocol';
import { presenceIcon, trayIcon, type Raster } from './tray-icons.ts';
import { trayModel, trayTooltip, type TrayItem, type TrayWho } from './tray-model.ts';

/** The sizes Windows asks for at 100%, 150%, 200% and 300% display scaling. */
const SCALES: Array<[number, number]> = [
  [1, 16],
  [1.5, 24],
  [2, 32],
  [3, 48],
];

/**
 * The icon in the notification area and its menu: the app's icon with the status dot (and a red
 * dot when something is unread), a menu with who this is, the status to pick, and Open and Quit.
 * What the menu holds comes from `trayModel`; this turns it into the native menu and pictures.
 */
export class AppTray {
  private readonly tray: Tray;
  private who: TrayWho | undefined;
  private unread = 0;
  private readonly appIcon: NativeImage;
  private readonly cache = new Map<string, NativeImage>();

  private readonly actions: {
    open(): void;
    quit(): void;
    setPresence(state: ManualPresenceState): void;
  };

  constructor(iconPath: string, actions: AppTray['actions']) {
    this.actions = actions;
    this.appIcon = nativeImage.createFromPath(iconPath);
    this.tray = new Tray(this.iconFor(undefined, false));
    this.tray.on('click', () => this.actions.open());
    this.refresh();
  }

  setWho(who: TrayWho): void {
    this.who = who;
    this.refresh();
  }

  setUnread(count: number): void {
    if (count === this.unread) return;
    this.unread = count;
    this.refresh();
  }

  /** What the menu holds now (tests read it). */
  model(): TrayItem[] {
    return trayModel(this.who, this.unread);
  }

  tooltip(): string {
    return trayTooltip(this.who, this.unread);
  }

  /** Do what clicking an item does; false for one that is not there or does nothing. */
  run(id: string): boolean {
    if (id === 'quit') this.actions.quit();
    else if (id === 'open' || id === 'header' || id === 'unread') this.actions.open();
    else if (id === 'status-reset') this.actions.setPresence('available');
    else if (id.startsWith('presence:'))
      this.actions.setPresence(id.slice('presence:'.length) as ManualPresenceState);
    else return false;
    return true;
  }

  /** Show the menu where the pointer is (tests and screenshots). */
  popUp(): void {
    this.tray.popUpContextMenu();
  }

  private refresh(): void {
    // The dot shows what colleagues see; in a call that is "in a call", which is the busy dot.
    const shown: PresenceState | undefined = this.who
      ? this.who.inCall
        ? 'busy'
        : this.who.presence
      : undefined;
    this.tray.setImage(this.iconFor(shown, this.unread > 0));
    this.tray.setToolTip(this.tooltip());
    this.tray.setContextMenu(Menu.buildFromTemplate(this.template(this.model())));
  }

  private fromRasters(rasters: Array<[number, Raster]>): NativeImage {
    const [first, ...rest] = rasters;
    const image = nativeImage.createFromBitmap(first![1].bgra, {
      width: first![1].width,
      height: first![1].height,
      scaleFactor: first![0],
    });
    for (const [scaleFactor, r] of rest)
      image.addRepresentation({ scaleFactor, width: r.width, height: r.height, buffer: r.bgra });
    return image;
  }

  private iconFor(state: PresenceState | undefined, unread: boolean): NativeImage {
    const key = `tray:${state ?? '-'}:${unread}`;
    let image = this.cache.get(key);
    if (!image) {
      image = this.fromRasters(
        SCALES.map(([scale, size]) => {
          const base = this.appIcon.resize({ width: size, height: size, quality: 'best' });
          const raster: Raster = { width: size, height: size, bgra: base.toBitmap() };
          return [scale, trayIcon(raster, state, unread)];
        }),
      );
      this.cache.set(key, image);
    }
    return image;
  }

  private dotFor(state: PresenceState): NativeImage {
    const key = `dot:${state}`;
    let image = this.cache.get(key);
    if (!image) {
      image = this.fromRasters(SCALES.map(([scale, size]) => [scale, presenceIcon(state, size)]));
      this.cache.set(key, image);
    }
    return image;
  }

  private appFor(): NativeImage {
    let image = this.cache.get('app');
    if (!image) {
      image = this.fromRasters(
        SCALES.map(([scale, size]) => {
          const small = this.appIcon.resize({ width: size, height: size, quality: 'best' });
          return [scale, { width: size, height: size, bgra: small.toBitmap() }];
        }),
      );
      this.cache.set('app', image);
    }
    return image;
  }

  private template(items: TrayItem[]): MenuItemConstructorOptions[] {
    return items.map((item): MenuItemConstructorOptions => {
      if (item.separator) return { type: 'separator' };
      const picture = item.dot ? this.dotFor(item.dot) : item.app ? this.appFor() : undefined;
      return {
        label: item.label,
        ...(item.enabled === false && { enabled: false }),
        ...(picture && { icon: picture }),
        ...(item.checked !== undefined && { type: 'radio' as const, checked: item.checked }),
        ...(item.children
          ? { submenu: this.template(item.children) }
          : { click: () => this.run(item.id) }),
      };
    });
  }
}
