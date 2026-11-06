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
  it('значения тем до 1.13.0 читаются как новые: light → «Океан», dark и black → «Чёрный океан»', () => {
    expect(parseThemeMode('light')).toBe('ocean');
    expect(parseThemeMode('dark')).toBe('black');
    expect(parseThemeMode('black')).toBe('black');
    const store = memoryStore();
    store.setItem('ibportal.theme', 'dark');
    expect(loadThemeMode(store)).toBe('black');
  });

  it('по умолчанию «Авто», неизвестное значение тоже «Авто»', () => {
    expect(parseThemeMode(null)).toBe('auto');
    expect(parseThemeMode('sepia')).toBe('auto');
    expect(loadThemeMode(undefined)).toBe('auto');
  });

  it('сохраняет и читает выбор', () => {
    const store = memoryStore();
    saveThemeMode(store, 'black');
    expect(loadThemeMode(store)).toBe('black');
    saveThemeMode(store, 'ocean');
    expect(loadThemeMode(store)).toBe('ocean');
  });

  it('не падает, если хранилище недоступно', () => {
    const broken: KeyValueStore = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    };
    expect(loadThemeMode(broken)).toBe('auto');
    expect(() => saveThemeMode(broken, 'ocean')).not.toThrow();
  });

  it('«Чёрный» и «Океан» ставят data-theme, «Авто» снимает', () => {
    const root = fakeRoot();
    applyThemeMode(root, 'black');
    expect(root.attrs.get('data-theme')).toBe('black');
    applyThemeMode(root, 'ocean');
    expect(root.attrs.get('data-theme')).toBe('ocean');
    applyThemeMode(root, 'auto');
    expect(root.attrs.has('data-theme')).toBe(false);
  });
});
