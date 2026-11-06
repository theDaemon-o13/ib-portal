// Общая периодичность (1.11.0, ADR-0041): номинальные даты по периодичности и перенос с нерабочего дня. Ею пользуются
// расписание рассылок (1.9.0, ADR-0040; свой список видов — awareness-letters/cadence.ts) и автоматизации механизмов
// контроля документов (ADR-0043). У каждого модуля — свой список разрешённых видов; вычисления — здесь, одни на всех.
// Все даты — строки YYYY-MM-DD в часовом поясе портала («сегодня» даёт lib/today.ts).
import { z } from 'zod';
import { addDaysIso } from './today.js';
import { isoDate, isoWeekday, onOrPrevWorkingDay, parseIsoDate, type WorkCalendar } from './working-days.js';

export const Day = z.number().int().min(1).max(31);

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Все виды периодичности; модуль сужает список своей схемой. */
export type AnyCadence =
  | { kind: 'daily' }
  | { kind: 'weekly'; every: number; weekday: number }
  | { kind: 'monthly'; day: number }
  | { kind: 'twice_monthly'; days: [number, number] }
  | { kind: 'quarterly'; month: number; day: number }
  | { kind: 'semiannual'; month: number; day: number }
  | { kind: 'yearly'; month: number; day: number };

const pad = (n: number) => String(n).padStart(2, '0');
/** День месяца, которого нет (29–31 в коротком месяце), — последний день месяца. */
function clampedDate(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(Math.min(day, daysInMonth(year, month)))}`;
}

/** Номинальные даты периодичности в [from; to] (включительно), не раньше startsOn, по возрастанию. */
export function nominalDates(c: AnyCadence, startsOn: string, from: string, to: string): string[] {
  const lo = from > startsOn ? from : startsOn;
  if (lo > to) return [];
  const out = new Set<string>();
  if (c.kind === 'daily') {
    for (let d = lo; d <= to; d = addDaysIso(d, 1)) out.add(d);
    return [...out];
  }
  if (c.kind === 'weekly') {
    // Первая дата — первый такой день недели не раньше даты начала; дальше — шаг N недель.
    const start = parseIsoDate(startsOn);
    const first = addDaysIso(startsOn, (c.weekday - isoWeekday(start) + 7) % 7);
    const step = c.every * 7;
    const gap = Math.max(0, Math.round((Date.parse(`${lo}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000));
    for (let d = addDaysIso(first, Math.ceil(gap / step) * step); d <= to; d = addDaysIso(d, step)) {
      if (d >= lo) out.add(d);
    }
    return [...out].sort();
  }
  const [y0, m0] = lo.split('-').map(Number) as [number, number];
  const [y1, m1] = to.split('-').map(Number) as [number, number];
  for (let y = y0, m = m0; y < y1 || (y === y1 && m <= m1); m === 12 ? (y++, m = 1) : m++) {
    const days: number[] = [];
    if (c.kind === 'monthly') days.push(c.day);
    else if (c.kind === 'twice_monthly') days.push(...c.days);
    else if (c.kind === 'quarterly') {
      if ((m - 1) % 3 === c.month - 1) days.push(c.day);
    } else if (c.kind === 'semiannual') {
      if ((m - 1) % 6 === c.month - 1) days.push(c.day);
    } else if (m === c.month) days.push(c.day);
    for (const d of days) {
      const iso = clampedDate(y, m, d);
      if (iso >= lo && iso <= to) out.add(iso);
    }
  }
  return [...out].sort();
}

/**
 * Плановая дата: номинальная или, если она нерабочая, предыдущий рабочий день по производственному календарю
 * (правило рассылок и автоматизаций со сроком в рабочих днях — решение владельца 7). 'none' — без переноса.
 */
export function plannedDate(nominal: string, cal: WorkCalendar, shift: 'prev' | 'none' = 'prev'): string {
  return shift === 'none' ? nominal : isoDate(onOrPrevWorkingDay(parseIsoDate(nominal), cal));
}
