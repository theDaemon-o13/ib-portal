// Оформление: «Авто / Светлая / Чёрная». Хранится только в localStorage (UI-состояние).

export type ThemeMode = 'auto' | 'light' | 'dark';

export const THEME_MODES: { mode: ThemeMode; label: string }[] = [
  { mode: 'auto', label: 'Авто' },
  { mode: 'light', label: 'Светлая' },
  { mode: 'dark', label: 'Чёрная' },
];

const STORAGE_KEY = 'ibportal.theme';

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface ThemeRoot {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

export function parseThemeMode(value: string | null | undefined): ThemeMode {
  return value === 'light' || value === 'dark' ? value : 'auto';
}

export function loadThemeMode(store: KeyValueStore | undefined): ThemeMode {
  try {
    return parseThemeMode(store?.getItem(STORAGE_KEY));
  } catch {
    return 'auto';
  }
}

export function saveThemeMode(store: KeyValueStore | undefined, mode: ThemeMode): void {
  try {
    store?.setItem(STORAGE_KEY, mode);
  } catch {
    // хранилище недоступно (приватное окно) — тема просто не запомнится
  }
}

/** «Авто» снимает data-theme: работает prefers-color-scheme из tokens.css. */
export function applyThemeMode(root: ThemeRoot, mode: ThemeMode): void {
  if (mode === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
}
