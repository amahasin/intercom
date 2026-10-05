import { useSyncExternalStore } from 'react';
import {
  createHighContrastTheme,
  webDarkTheme,
  webLightTheme,
  type Theme,
} from '@fluentui/react-components';

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

/** Light, dark or high contrast, following Windows. */
export function useSystemTheme(): { theme: Theme; mode: 'light' | 'dark' | 'contrast' } {
  const contrast = useMedia('(forced-colors: active)');
  const dark = useMedia('(prefers-color-scheme: dark)');
  if (contrast) return { theme: highContrastTheme, mode: 'contrast' };
  return dark ? { theme: webDarkTheme, mode: 'dark' } : { theme: webLightTheme, mode: 'light' };
}
