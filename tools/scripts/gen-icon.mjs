// Renders the InterCom mark (renderer/src/shell/Logo.tsx) to PNG and ICO with no image
// dependencies: signed-distance shapes, 4x4 supersampling, zlib for PNG.
// Writes apps/desktop/build/icon.png (512) and icon.ico (16-256).
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

const OUT = resolve(import.meta.dirname, '../../apps/desktop/build');
const TEAL = [0x14, 0xb8, 0xa6];
const INDIGO = [0x4f, 0x46, 0xe5];

// Geometry in the logo's 32x32 viewBox: a speech bubble with a tail at the bottom left and
// three dots (the typing indicator) in it.
const BUBBLE = { cx: 16, cy: 14, hw: 14, hh: 11, r: 8 };
const TAIL = [
  [6.5, 21],
  [15, 24.5],
  [5, 30],
];
const DOTS = [
  [10, 14],
  [16, 14],
  [22, 14],
];

function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function inTriangle(x, y, [a, b, c]) {
  const side = (p, q) => (x - q[0]) * (p[1] - q[1]) - (p[0] - q[0]) * (y - q[1]);
  const d1 = side(a, b);
  const d2 = side(b, c);
  const d3 = side(c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/** Colour (premultiplied RGBA, 0-1) of one point in viewBox space. */
function sample(x, y) {
  const body = sdRoundRect(x, y, BUBBLE.cx, BUBBLE.cy, BUBBLE.hw, BUBBLE.hh, BUBBLE.r) <= 0;
  if (!body && !inTriangle(x, y, TAIL)) return [0, 0, 0, 0];
  if (DOTS.some(([dx, dy]) => Math.hypot(x - dx, y - dy) <= 2.2)) return [1, 1, 1, 1];
  const t = Math.max(0, Math.min(1, (x + y - 2) / 60));
  const rgb = TEAL.map((c, i) => (c + (INDIGO[i] - c) * t) / 255);
  return [...rgb, 1];
}

function render(size) {
  const ss = 4;
  const px = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sj = 0; sj < ss; sj++) {
        for (let si = 0; si < ss; si++) {
          const x = ((i + (si + 0.5) / ss) / size) * 32;
          const y = ((j + (sj + 0.5) / ss) / size) * 32;
          const [cr, cg, cb, ca] = sample(x, y);
          r += cr * ca;
          g += cg * ca;
          b += cb * ca;
          a += ca;
        }
      }
      const n = ss * ss;
      const o = (j * size + i) * 4;
      const alpha = a / n;
      px[o] = alpha ? Math.round((r / a) * 255) : 0;
      px[o + 1] = alpha ? Math.round((g / a) * 255) : 0;
      px[o + 2] = alpha ? Math.round((b / a) * 255) : 0;
      px[o + 3] = Math.round(alpha * 255);
    }
  }
  return px;
}

function png(size, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++)
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(resolve(OUT, 'icon.png'), png(512, render(512)));
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
writeFileSync(
  resolve(OUT, 'icon.ico'),
  ico(sizes.map((size) => ({ size, data: png(size, render(size)) }))),
);
console.log(`wrote icon.png and icon.ico (${sizes.join(', ')}) to ${OUT}`);
