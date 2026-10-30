import { useMemo } from 'react';

/** Сегодня по местному времени (ГГГГ-ММ-ДД): для ограничений дат и подписей срока. Окончательно проверяет backend. */
export function todayIso(now = new Date()): string {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

export function useTodayIso(): string {
  return useMemo(() => todayIso(), []);
}
