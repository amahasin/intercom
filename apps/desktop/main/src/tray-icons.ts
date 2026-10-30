import type { PresenceState } from '@officemesh/protocol';

/**
 * The little pictures of the tray: a coloured dot for each status (with a mark inside it where there
 * is room: a tick, a bar, clock hands), and the dots laid over the app's icon. Drawn by hand into
 * BGRA bitmaps, so no image files or fonts are needed and every size looks the same.
 */
export interface Raster {
  width: number;
  height: number;
  /** Premultiplied BGRA, the order Electron's `nativeImage.createFromBitmap` takes. */
  bgra: Buffer;
}

type Rgb = readonly [number, number, number];

/** Green, red, amber and grey of the status dots. */
export const PRESENCE_COLOR: Record<PresenceState, Rgb> = {
  available: [0x10, 0x7c, 0x10],
  busy: [0xc4, 0x2b, 0x1c],
  dnd: [0xc4, 0x2b, 0x1c],
  brb: [0xea, 0xa3, 0x00],
  away: [0xea, 0xa3, 0x00],
  offline: [0x8a, 0x88, 0x86],
};
const UNREAD_COLOR: Rgb = [0xe8, 0x11, 0x23];
const WHITE: Rgb = [255, 255, 255];

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** Lay `rgb` over the pixel at (x, y) with coverage `a` (0 to 1): "source over", premultiplied. */
function over(r: Raster, x: number, y: number, rgb: Rgb, a: number): void {
  if (a <= 0 || x < 0 || y < 0 || x >= r.width || y >= r.height) return;
  const o = (y * r.width + x) * 4;
  const keep = 1 - a;
  r.bgra[o] = Math.round(rgb[2] * a + r.bgra[o]! * keep);
  r.bgra[o + 1] = Math.round(rgb[1] * a + r.bgra[o + 1]! * keep);
  r.bgra[o + 2] = Math.round(rgb[0] * a + r.bgra[o + 2]! * keep);
  r.bgra[o + 3] = Math.round(255 * a + r.bgra[o + 3]! * keep);
}

/** Visit every pixel a shape could cover, giving its distance-based coverage. */
function paint(
  r: Raster,
  box: { x0: number; y0: number; x1: number; y1: number },
  rgb: Rgb,
  coverage: (px: number, py: number) => number,
): void {
  for (let y = Math.max(0, Math.floor(box.y0)); y <= Math.min(r.height - 1, Math.ceil(box.y1)); y++)
    for (
      let x = Math.max(0, Math.floor(box.x0));
      x <= Math.min(r.width - 1, Math.ceil(box.x1));
      x++
    )
      over(r, x, y, rgb, clamp01(coverage(x + 0.5, y + 0.5)));
}

/** A filled disc, soft at the edge by one pixel. */
function disc(r: Raster, cx: number, cy: number, radius: number, rgb: Rgb): void {
  paint(
    r,
    { x0: cx - radius - 1, y0: cy - radius - 1, x1: cx + radius + 1, y1: cy + radius + 1 },
    rgb,
    (px, py) => radius - Math.hypot(px - cx, py - cy) + 0.5,
  );
}

/** A ring: the band between `radius - width` and `radius`. */
function ring(r: Raster, cx: number, cy: number, radius: number, width: number, rgb: Rgb): void {
  paint(
    r,
    { x0: cx - radius - 1, y0: cy - radius - 1, x1: cx + radius + 1, y1: cy + radius + 1 },
    rgb,
    (px, py) => {
      const d = Math.hypot(px - cx, py - cy);
      return Math.min(radius - d + 0.5, d - (radius - width) + 0.5);
    },
  );
}

/** A line of the given thickness with round ends. */
function line(
  r: Raster,
  a: readonly [number, number],
  b: readonly [number, number],
  thickness: number,
  rgb: Rgb,
): void {
  const half = thickness / 2;
  paint(
    r,
    {
      x0: Math.min(a[0], b[0]) - half - 1,
      y0: Math.min(a[1], b[1]) - half - 1,
      x1: Math.max(a[0], b[0]) + half + 1,
      y1: Math.max(a[1], b[1]) + half + 1,
    },
    rgb,
    (px, py) => {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const t = clamp01(((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy || 1));
      return half - Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy)) + 0.5;
    },
  );
}

const blank = (size: number): Raster => ({
  width: size,
  height: size,
  bgra: Buffer.alloc(size * size * 4),
});

/** The status dot with its mark, centred at (cx, cy), `radius` big, drawn onto `r`. */
function statusDot(
  r: Raster,
  state: PresenceState,
  cx: number,
  cy: number,
  radius: number,
  mark: boolean,
): void {
  if (state === 'offline') {
    ring(r, cx, cy, radius, Math.max(1.4, radius * 0.28), PRESENCE_COLOR.offline);
    return;
  }
  disc(r, cx, cy, radius, PRESENCE_COLOR[state]);
  if (!mark) return;
  const w = Math.max(1.2, radius * 0.24);
  const at = (dx: number, dy: number): [number, number] => [cx + dx * radius, cy + dy * radius];
  if (state === 'available') {
    // A tick.
    line(r, at(-0.5, 0.02), at(-0.12, 0.4), w, WHITE);
    line(r, at(-0.12, 0.4), at(0.52, -0.38), w, WHITE);
  } else if (state === 'dnd') {
    line(r, at(-0.5, 0), at(0.5, 0), w * 1.15, WHITE);
  } else if (state === 'brb' || state === 'away') {
    // Clock hands, at ten past twelve.
    line(r, at(0, 0), at(0, -0.58), w, WHITE);
    line(r, at(0, 0), at(0.46, 0.22), w, WHITE);
  }
}

/** The picture for a status in a menu: its dot, the whole size, with its mark. */
export function presenceIcon(state: PresenceState, size: number): Raster {
  const r = blank(size);
  statusDot(r, state, size / 2, size / 2, size / 2 - 0.5, true);
  return r;
}

/**
 * The app's icon with the status dot at its lower right (ringed in white so it reads on a dark or a
 * light taskbar) and, when something is unread, a red dot at its upper right. `base` is the icon
 * at this size.
 */
export function trayIcon(base: Raster, state: PresenceState | undefined, unread: boolean): Raster {
  const size = base.width;
  const r: Raster = { width: base.width, height: base.height, bgra: Buffer.from(base.bgra) };
  const dot = size * 0.23;
  if (state) {
    const cx = size - dot - size * 0.02;
    const cy = size - dot - size * 0.02;
    disc(r, cx, cy, dot + Math.max(1, size * 0.06), WHITE);
    statusDot(r, state, cx, cy, dot, size >= 32);
  }
  if (unread) {
    const cx = size - dot - size * 0.02;
    const cy = dot + size * 0.02;
    disc(r, cx, cy, dot + Math.max(1, size * 0.06), WHITE);
    disc(r, cx, cy, dot, UNREAD_COLOR);
  }
  return r;
}
