import { useEffect, useState } from 'react';
import { applyThemeMode, loadThemeMode, saveThemeMode, THEME_MODES, type ThemeMode } from '../theme/theme';

const storage = (): Storage | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

export function initTheme(): void {
  applyThemeMode(document.documentElement, loadThemeMode(storage()));
}

export function ThemeSwitch() {
  const [mode, setMode] = useState<ThemeMode>(() => loadThemeMode(storage()));

  useEffect(() => {
    applyThemeMode(document.documentElement, mode);
    saveThemeMode(storage(), mode);
  }, [mode]);

  return (
    <div className="seg-top" role="group" aria-label="Оформление">
      {THEME_MODES.map((t) => (
        <button key={t.mode} type="button" aria-pressed={mode === t.mode} title={t.title} onClick={() => setMode(t.mode)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
