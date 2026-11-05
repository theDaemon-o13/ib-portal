import { describe, expect, it } from 'vitest';
import { clearExpired, isBackground, markExpired, noteUserInput, wasExpired } from './session';

describe('сессия в браузере', () => {
  it('запрос без щелчка и клавиши дольше 5 секунд — фоновый', () => {
    noteUserInput(1_000);
    expect(isBackground(5_000)).toBe(false);
    expect(isBackground(6_001)).toBe(true);
  });

  it('сессия закрыта посреди работы — отметка для страницы входа, после входа снимается', () => {
    markExpired();
    expect(wasExpired()).toBe(true);
    clearExpired();
    expect(wasExpired()).toBe(false);
  });
});
