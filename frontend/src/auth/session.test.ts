import { describe, expect, it } from 'vitest';
import { isBackground, noteIdleRemaining, noteUserInput, sessionDeadline, sessionPhase, WARN_BEFORE_MS } from './session';

describe('сессия в браузере', () => {
  it('запрос без щелчка и клавиши дольше 5 секунд — фоновый', () => {
    noteUserInput(1_000);
    expect(isBackground(5_000)).toBe(false);
    expect(isBackground(6_001)).toBe(true);
  });

  it('предупреждение за 2 минуты; после срока — завершена; остаток из заголовка', () => {
    noteIdleRemaining('600000', 0);
    expect(sessionDeadline()).toBe(600_000);
    noteIdleRemaining(null, 1);
    expect(sessionDeadline()).toBe(600_000);
    expect(sessionPhase(600_000, 600_000 - WARN_BEFORE_MS - 1)).toBe('ok');
    expect(sessionPhase(600_000, 600_000 - WARN_BEFORE_MS)).toBe('warn');
    expect(sessionPhase(600_000, 600_000)).toBe('over');
    expect(sessionPhase(null, 0)).toBe('ok');
  });
});
