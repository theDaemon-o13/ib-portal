// Оформление (1.13.0, ADR-0047): «Авто / Океан / Чёрный». Хранится только в localStorage (UI-состояние), на сервере
// темы нет. Значения тем до 1.13.0 читаются как новые: «light» → «Океан», «dark» и «black» → «Чёрный океан».

export type ThemeMode = 'auto' | 'ocean' | 'black';

export const THEME_MODES: { mode: ThemeMode; label: string; title: string }[] = [
  { mode: 'auto', label: 'Авто', title: 'Как в системе: светлая — «Океан», тёмная — «Чёрный океан»' },
  { mode: 'ocean', label: 'Океан', title: 'Тема «Океан»' },
  { mode: 'black', label: 'Чёрный', title: 'Тема «Чёрный океан»' },
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

/** Прочитать выбор: новые значения и значения тем до 1.13.0; неизвестное — «Авто». */
export function parseThemeMode(value: string | null | undefined): ThemeMode {
  if (value === 'ocean' || value === 'light') return 'ocean';
  if (value === 'black' || value === 'dark') return 'black';
  return 'auto';
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
