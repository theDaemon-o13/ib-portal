// Блокировка входа: после 5 неудачных попыток — 15 минут (CLAUDE.md, раздел 5).

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_DURATION_MS = 15 * 60 * 1000;

export interface LockoutState {
  failedLoginCount: number;
  lockedUntil: Date | null;
}

export function isLocked(state: LockoutState, now: Date): boolean {
  return state.lockedUntil !== null && state.lockedUntil.getTime() > now.getTime();
}

/** Новое состояние после неудачной попытки. Вызывается, только если учётная запись не заблокирована. */
export function registerFailure(state: LockoutState, now: Date): LockoutState & { lockedNow: boolean } {
  // Прошлая блокировка истекла — счёт начинается заново.
  const previous = state.lockedUntil !== null ? 0 : state.failedLoginCount;
  const failedLoginCount = previous + 1;
  if (failedLoginCount >= MAX_FAILED_ATTEMPTS) {
    return {
      failedLoginCount,
      lockedUntil: new Date(now.getTime() + LOCK_DURATION_MS),
      lockedNow: true,
    };
  }
  return { failedLoginCount, lockedUntil: null, lockedNow: false };
}

export function registerSuccess(): LockoutState {
  return { failedLoginCount: 0, lockedUntil: null };
}
