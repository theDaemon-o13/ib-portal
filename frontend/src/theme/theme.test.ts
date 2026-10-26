import { describe, expect, it } from 'vitest';
import { applyThemeMode, loadThemeMode, parseThemeMode, saveThemeMode, type KeyValueStore } from './theme';

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

function fakeRoot() {
  const attrs = new Map<string, string>();
  return {
    attrs,
    setAttribute: (n: string, v: string) => void attrs.set(n, v),
    removeAttribute: (n: string) => void attrs.delete(n),
  };
}

describe('тема', () => {
  it('по умолчанию «Авто», неизвестное значение тоже «Авто»', () => {
    expect(parseThemeMode(null)).toBe('auto');
    expect(parseThemeMode('sepia')).toBe('auto');
    expect(loadThemeMode(undefined)).toBe('auto');
  });

  it('сохраняет и читает выбор', () => {
    const store = memoryStore();
    saveThemeMode(store, 'dark');
    expect(loadThemeMode(store)).toBe('dark');
  });

  it('не падает, если хранилище недоступно', () => {
    const broken: KeyValueStore = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    };
    expect(loadThemeMode(broken)).toBe('auto');
    expect(() => saveThemeMode(broken, 'light')).not.toThrow();
  });

  it('«Чёрная» и «Светлая» ставят data-theme, «Авто» снимает', () => {
    const root = fakeRoot();
    applyThemeMode(root, 'dark');
    expect(root.attrs.get('data-theme')).toBe('dark');
    applyThemeMode(root, 'light');
    expect(root.attrs.get('data-theme')).toBe('light');
    applyThemeMode(root, 'auto');
    expect(root.attrs.has('data-theme')).toBe(false);
  });
});
