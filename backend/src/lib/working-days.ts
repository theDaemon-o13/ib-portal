// Рабочие дни по производственному календарю РТ.
// Обычная неделя задаётся выходными днями (ISO: 1 — понедельник … 7 — воскресенье),
// календарь хранит отклонения: holiday — нерабочий день, workday — рабочий (перенос на выходной).

export type CalendarDayKind = 'holiday' | 'workday';

export interface WorkCalendar {
  weekendDays: readonly number[];
  /** Ключ — дата YYYY-MM-DD. */
  days: ReadonlyMap<string, CalendarDayKind>;
}

export const DEFAULT_WEEKEND_DAYS = [6, 7] as const;

/** Дата без времени в формате YYYY-MM-DD (по UTC — календарные даты хранятся как DATE). */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function parseIsoDate(s: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`неверная дата: ${s}`);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || isoDate(d) !== s) throw new Error(`неверная дата: ${s}`);
  return d;
}

/** ISO-день недели: 1 — понедельник … 7 — воскресенье. */
export function isoWeekday(d: Date): number {
  const w = d.getUTCDay();
  return w === 0 ? 7 : w;
}

export function isWorkingDay(d: Date, cal: WorkCalendar): boolean {
  const special = cal.days.get(isoDate(d));
  if (special === 'holiday') return false;
  if (special === 'workday') return true;
  return !cal.weekendDays.includes(isoWeekday(d));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Дата через n рабочих дней после from (from не считается). n = 0 — сам from. */
export function addWorkingDays(from: Date, n: number, cal: WorkCalendar): Date {
  if (!Number.isInteger(n) || n < 0) throw new Error('n должно быть целым неотрицательным');
  if (cal.weekendDays.length >= 7) throw new Error('в неделе нет рабочих дней');
  let d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  let left = n;
  // Ограничение от бесконечного цикла при ошибочном календаре.
  for (let guard = 0; left > 0; guard++) {
    if (guard > 3660) throw new Error('не удалось найти рабочие дни в пределах 10 лет');
    d = new Date(d.getTime() + DAY_MS);
    if (isWorkingDay(d, cal)) left--;
  }
  return d;
}

/** Число рабочих дней в интервале (from, to]. */
export function workingDaysBetween(from: Date, to: Date, cal: WorkCalendar): number {
  let count = 0;
  for (let d = new Date(from.getTime() + DAY_MS); isoDate(d) <= isoDate(to); d = new Date(d.getTime() + DAY_MS)) {
    if (isWorkingDay(d, cal)) count++;
  }
  return count;
}

/** Ближайший рабочий день, начиная с самого d: срок на праздник или выходной переносится вперёд. */
export function onOrNextWorkingDay(d: Date, cal: WorkCalendar): Date {
  if (isWorkingDay(d, cal)) return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  return addWorkingDays(d, 1, cal);
}

/**
 * Ближайший рабочий день, начиная с самого d, назад: плановая дата рассылки на выходном или празднике переносится
 * на предыдущий рабочий день (1.9.0, ADR-0040). Перенос может уйти в предыдущий месяц.
 */
export function onOrPrevWorkingDay(d: Date, cal: WorkCalendar): Date {
  if (cal.weekendDays.length >= 7) throw new Error('в неделе нет рабочих дней');
  let x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  for (let guard = 0; !isWorkingDay(x, cal); guard++) {
    if (guard > 3660) throw new Error('не удалось найти рабочий день в пределах 10 лет');
    x = new Date(x.getTime() - DAY_MS);
  }
  return x;
}
