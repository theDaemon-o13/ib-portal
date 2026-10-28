import { describe, expect, it } from 'vitest';
import { loadRememberedLogin, saveRememberedLogin, type LoginStore } from './remembered-login';

function memoryStore(): LoginStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe('запомнить логин', () => {
  it('хранится только логин, без пробелов по краям', () => {
    const s = memoryStore();
    saveRememberedLogin(s, ' ivanov ', true);
    expect([...s.data.values()]).toEqual(['ivanov']);
    expect(loadRememberedLogin(s)).toBe('ivanov');
  });

  it('без галочки запомненный логин удаляется', () => {
    const s = memoryStore();
    saveRememberedLogin(s, 'ivanov', true);
    saveRememberedLogin(s, 'ivanov', false);
    expect(s.data.size).toBe(0);
    expect(loadRememberedLogin(s)).toBe('');
  });

  it('недоступное хранилище не ломает вход', () => {
    const broken: LoginStore = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    };
    expect(loadRememberedLogin(broken)).toBe('');
    expect(() => saveRememberedLogin(broken, 'ivanov', true)).not.toThrow();
    expect(loadRememberedLogin(undefined)).toBe('');
  });
});
