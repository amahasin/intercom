import { nativeImage, type NativeImage } from 'electron';

// 3x5 pixel digits (rows top to bottom, bits left to right) and a plus sign.
const GLYPHS: Record<string, number[]> = {
  '0': [7, 5, 5, 5, 7],
  '1': [2, 6, 2, 2, 7],
  '2': [7, 1, 7, 4, 7],
  '3': [7, 1, 7, 1, 7],
  '4': [5, 5, 7, 1, 1],
  '5': [7, 4, 7, 1, 7],
  '6': [7, 4, 7, 5, 7],
  '7': [7, 1, 1, 1, 1],
  '8': [7, 5, 7, 5, 7],
  '9': [7, 5, 7, 1, 7],
  '+': [0, 2, 7, 2, 0],
};

/**
 * The taskbar overlay: a red disc with the unread count ("9+" above nine), drawn into a
 * 32x32 BGRA bitmap so no image assets or fonts are needed.
 */
export function badgeImage(count: number): NativeImage {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  const text = count > 9 ? '9+' : String(count);
  const scale = 3;
  const glyphW = 3 * scale;
  const gap = 2;
  const width = text.length * glyphW + (text.length - 1) * gap;
  const left = Math.round((size - width) / 2);
  const top = Math.round((size - 5 * scale) / 2);
  const isText = (x: number, y: number) => {
    for (let k = 0; k < text.length; k++) {
      const gx = x - (left + k * (glyphW + gap));
      const gy = y - top;
      if (gx < 0 || gy < 0 || gx >= glyphW || gy >= 5 * scale) continue;
      const row = GLYPHS[text[k]!]![Math.floor(gy / scale)]!;
      if (row & (4 >> Math.floor(gx / scale))) return true;
    }
    return false;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2);
      const alpha = Math.max(0, Math.min(1, size / 2 - d));
      if (alpha === 0) continue;
      const o = (y * size + x) * 4;
      const white = isText(x, y);
      // BGRA, premultiplied.
      buf[o] = Math.round((white ? 255 : 0x29) * alpha);
      buf[o + 1] = Math.round((white ? 255 : 0x38) * alpha);
      buf[o + 2] = Math.round((white ? 255 : 0xc4) * alpha);
      buf[o + 3] = Math.round(255 * alpha);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}
