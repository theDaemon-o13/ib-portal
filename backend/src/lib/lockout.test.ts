import { describe, expect, it } from 'vitest';
import { isLocked, LOCK_DURATION_MS, MAX_FAILED_ATTEMPTS, registerFailure, registerSuccess, type LockoutState } from './lockout.js';

const t0 = new Date('2026-10-26T09:00:00Z');
const later = (ms: number) => new Date(t0.getTime() + ms);

function fail(times: number, start: LockoutState = { failedLoginCount: 0, lockedUntil: null }) {
  let s = start;
  let lockedNow = false;
  for (let i = 0; i < times; i++) ({ lockedNow, ...s } = registerFailure(s, t0));
  return { ...s, lockedNow };
}

describe('блокировка входа', () => {
  it('5 попыток и 15 минут', () => {
    expect(MAX_FAILED_ATTEMPTS).toBe(5);
    expect(LOCK_DURATION_MS).toBe(15 * 60 * 1000);
  });

  it('4 неудачи подряд не блокируют', () => {
    const s = fail(4);
    expect(s.failedLoginCount).toBe(4);
    expect(s.lockedNow).toBe(false);
    expect(isLocked(s, t0)).toBe(false);
  });

  it('5-я неудача блокирует на 15 минут', () => {
    const s = fail(5);
    expect(s.lockedNow).toBe(true);
    expect(s.lockedUntil?.getTime()).toBe(t0.getTime() + LOCK_DURATION_MS);
    expect(isLocked(s, later(LOCK_DURATION_MS - 1))).toBe(true);
    expect(isLocked(s, later(LOCK_DURATION_MS))).toBe(false);
  });

  it('после истечения блокировки счёт начинается заново', () => {
    const locked = fail(5);
    const after = registerFailure(locked, later(LOCK_DURATION_MS + 1));
    expect(after.failedLoginCount).toBe(1);
    expect(after.lockedNow).toBe(false);
  });

  it('успешный вход обнуляет счётчик', () => {
    expect(registerSuccess()).toEqual({ failedLoginCount: 0, lockedUntil: null });
  });
});
