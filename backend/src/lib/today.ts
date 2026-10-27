// «Сегодня» портала: календарная дата в часовом поясе банка (по умолчанию Душанбе, UTC+5).
// Сроки и автоматизации сравнивают даты YYYY-MM-DD, поэтому полночь считается по местному времени.

export const DEFAULT_TIME_ZONE = 'Asia/Dushanbe';

export function appTimeZone(): string {
  return process.env.APP_TZ || DEFAULT_TIME_ZONE;
}

/** Дата YYYY-MM-DD в часовом поясе tz. */
export function todayIso(now: Date = new Date(), tz: string = appTimeZone()): string {
  // en-CA форматирует как YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Число календарных дней от a до b (b − a), даты YYYY-MM-DD. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
