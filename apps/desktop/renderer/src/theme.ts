import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  createDarkTheme,
  createHighContrastTheme,
  createLightTheme,
  webDarkTheme,
  webLightTheme,
  type BrandVariants,
  type Theme,
} from '@fluentui/react-components';
import { useApp } from './state.ts';

const highContrastTheme = createHighContrastTheme();

function subscribeMedia(query: string) {
  return (onChange: () => void) => {
    const mql = window.matchMedia(query);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  };
}

function useMedia(query: string): boolean {
  return useSyncExternalStore(subscribeMedia(query), () => window.matchMedia(query).matches);
}

export type Look = 'classic' | 'harbor' | 'paper';

/**
 * The looks. The layout is the same in each; they differ in colour and roundness. `tint` warms
 * Fluent's greys (hue, saturation of the light greys and of the dark ones); `accent` is the
 * look's own accent colour, used when the user has not chosen one.
 */
const LOOKS: Record<
  Look,
  {
    accent: string;
    light?: { hue: number; light: number; dark: number };
    dark?: { hue: number; light: number; dark: number };
    radius?: { small: number; medium: number; large: number; xlarge: number };
  }
> = {
  classic: { accent: '#0F6CBD' },
  // Warm sand and deep teal, rounded.
  harbor: {
    accent: '#0F6E56',
    light: { hue: 43, light: 0.36, dark: 0.12 },
    dark: { hue: 165, light: 0.08, dark: 0.16 },
    radius: { small: 4, medium: 8, large: 12, xlarge: 16 },
  },
  // Cream paper and coral, rounder still.
  paper: {
    accent: '#C4512B',
    light: { hue: 36, light: 0.6, dark: 0.14 },
    dark: { hue: 28, light: 0.1, dark: 0.18 },
    radius: { small: 6, medium: 10, large: 14, xlarge: 20 },
  },
};

/** Accent colours offered in Settings (any other can be picked too). */
export const ACCENTS = [
  '#0F6E56',
  '#C4512B',
  '#0F6CBD',
  '#5B4DB7',
  '#B0336A',
  '#9A5B00',
  '#3B7A1E',
  '#0E7490',
  '#B42318',
  '#4A5568',
];

export function lookAccent(look: Look): string {
  return LOOKS[look].accent;
}

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]: Rgb): string {
  return `#${[r, g, b]
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === rr
      ? (gg - bb) / d + (gg < bb ? 6 : 0)
      : max === gg
        ? (bb - rr) / d + 2
        : (rr - gg) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return [f(0), f(8), f(4)];
}

/** WCAG contrast of a colour against white. */
function contrastWithWhite(rgb: Rgb): number {
  const lin = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const y = 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
  return 1.05 / (y + 0.05);
}

/** Black or white, whichever reads better on this colour (a check mark on a swatch). */
export function inkOn(hex: string): string {
  return contrastWithWhite(hexToRgb(hex)) >= 3 ? '#ffffff' : '#000000';
}

/**
 * Fluent's 16 brand shades from one colour. The colour sits at shade 80 (buttons, links, the
 * selected item), darkened if need be so white text on it stays readable (4.5:1), and kept
 * from being so dark that the dark theme's lighter shades disappear.
 */
export function brandRamp(accent: string): BrandVariants {
  const [h, s, l0] = rgbToHsl(hexToRgb(accent));
  let l = Math.max(0.22, l0);
  while (l > 0.22 && contrastWithWhite(hslToRgb(h, s, l)) < 4.5) l -= 0.01;
  const ramp: Record<number, string> = {};
  for (let k = 10; k <= 160; k += 10) {
    const shade = k <= 80 ? 0.06 + ((l - 0.06) * (k - 10)) / 70 : l + ((0.96 - l) * (k - 80)) / 80;
    const sat = k <= 80 ? s : s * (1 - (0.25 * (k - 80)) / 80);
    ramp[k] = rgbToHex(hslToRgb(h, sat, shade));
  }
  return ramp as BrandVariants;
}

/** Warm (or cool) every plain grey of a theme, keeping its lightness. */
function tintGreys(theme: Theme, tint: { hue: number; light: number; dark: number }): Theme {
  const out: Record<string, unknown> = { ...theme };
  for (const [key, value] of Object.entries(theme)) {
    if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) continue;
    const rgb = hexToRgb(value);
    if (Math.max(...rgb) - Math.min(...rgb) > 2) continue;
    const l = rgb[0] / 255;
    // Pure white and pure black stay as they are (cards, text on colour).
    if (l > 0.995 || l < 0.005) continue;
    out[key] = rgbToHex(hslToRgb(tint.hue, l > 0.5 ? tint.light : tint.dark, l));
  }
  return out as unknown as Theme;
}

/** The Fluent theme for a look, an accent (empty: the look's own) and light or dark. */
export function buildTheme(look: Look, accent: string, dark: boolean): Theme {
  const spec = LOOKS[look];
  const colour = accent || spec.accent;
  // The classic look with its own accent is exactly Fluent's web theme.
  if (look === 'classic' && !accent) return dark ? webDarkTheme : webLightTheme;
  const brand = brandRamp(colour);
  let theme: Theme = dark ? createDarkTheme(brand) : createLightTheme(brand);
  if (dark) {
    // Fluent's advice for a custom brand on dark: lighter shades for text and icons.
    theme = { ...theme, colorBrandForeground1: brand[110], colorBrandForeground2: brand[120] };
  } else if (look !== 'classic') {
    // A clearer tint for your own messages and selected items than Fluent's near-white.
    theme = { ...theme, colorBrandBackground2: brand[150], colorBrandBackground2Hover: brand[140] };
  }
  const tint = dark ? spec.dark : spec.light;
  if (tint) theme = tintGreys(theme, tint);
  if (spec.radius) {
    theme = {
      ...theme,
      borderRadiusSmall: `${spec.radius.small}px`,
      borderRadiusMedium: `${spec.radius.medium}px`,
      borderRadiusLarge: `${spec.radius.large}px`,
      borderRadiusXLarge: `${spec.radius.xlarge}px`,
    };
  }
  return theme;
}

// The last look is remembered in this browser profile too, so a window opens in it at once
// rather than flashing the default (Paper) until the settings arrive.
const REMEMBER = 'intercom.look';

function remembered(): { look: Look; accent: string } {
  try {
    const saved = JSON.parse(localStorage.getItem(REMEMBER) ?? 'null') as {
      look?: unknown;
      accent?: unknown;
    } | null;
    const look = saved?.look;
    const accent = saved?.accent;
    return {
      look: look === 'classic' || look === 'harbor' ? look : 'paper',
      accent: typeof accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : '',
    };
  } catch {
    return { look: 'paper', accent: '' };
  }
}

/** The app's theme: the chosen look and accent, light or dark, or Windows' high contrast. */
export function useAppTheme(): { theme: Theme; mode: 'light' | 'dark' | 'contrast' } {
  const contrast = useMedia('(forced-colors: active)');
  const dark = useMedia('(prefers-color-scheme: dark)');
  const settings = useApp((s) => s.settings);
  const [fallback] = useState(remembered);
  const look = settings?.look ?? fallback.look;
  const accent = settings?.accent ?? fallback.accent;
  useEffect(() => {
    document.documentElement.dataset.look = look;
    if (!settings) return;
    try {
      localStorage.setItem(REMEMBER, JSON.stringify({ look, accent }));
    } catch {
      // Not remembered: the window shows the default look for a moment next time.
    }
  }, [look, accent, settings]);
  const theme = useMemo(() => buildTheme(look, accent, dark), [look, accent, dark]);
  if (contrast) return { theme: highContrastTheme, mode: 'contrast' };
  return { theme, mode: dark ? 'dark' : 'light' };
}
