// Light / dark / same as the device. The choice is remembered on this device only (not on the server),
// and is applied as a data-theme attribute on <html>; index.css does the colours. No attribute = follow the device.

export type ThemeChoice = 'light' | 'dark' | 'system';
export const THEMES: ThemeChoice[] = ['light', 'dark', 'system'];
export const THEME_LABEL: Record<ThemeChoice, string> = { light: 'Light', dark: 'Dark', system: 'Device' };
export const THEME_HINT: Record<ThemeChoice, string> = { light: 'Always light', dark: 'Always dark', system: 'Same as my device' };
export const THEME_KEY = 'taabile-theme';

/** Anything that is not a known choice means "same as my device". */
export const parseTheme = (raw: unknown): ThemeChoice => (raw === 'light' || raw === 'dark' ? raw : 'system');

/** The saved choice. Storage can be blocked (private windows), so this never throws. */
export function readTheme(storage: Pick<Storage, 'getItem'> | null = safeStorage()): ThemeChoice {
  try {
    return parseTheme(storage?.getItem(THEME_KEY));
  } catch {
    return 'system';
  }
}

export function saveTheme(choice: ThemeChoice, storage: Pick<Storage, 'setItem' | 'removeItem'> | null = safeStorage()): void {
  try {
    if (choice === 'system') storage?.removeItem(THEME_KEY);
    else storage?.setItem(THEME_KEY, choice);
  } catch {
    /* the choice still applies until the page is closed */
  }
}

export function applyTheme(choice: ThemeChoice, root: Pick<HTMLElement, 'setAttribute' | 'removeAttribute'> = document.documentElement): void {
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}