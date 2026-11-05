// Периодичность правил рассылки (1.9.0, ADR-0040; docs/specs/awareness.md, раздел 19.2).
// Номинальная дата — по периодичности; плановая — номинальная, перенесённая на предыдущий рабочий день.
// Ключ идемпотентности запуска — «правило + номинальная дата»: смена календаря двигает плановую дату, но не ключ.
// Все даты — строки YYYY-MM-DD в часовом поясе портала («сегодня» даёт lib/today.ts).
import { z } from 'zod';
import { addDaysIso } from '../../lib/today.js';
import { isoDate, isoWeekday, onOrPrevWorkingDay, parseIsoDate, type WorkCalendar } from '../../lib/working-days.js';

const Day = z.number().int().min(1).max(31);

export const CadenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('monthly'), day: Day }),
  z.object({ kind: z.literal('twice_monthly'), days: z.tuple([Day, Day]) })
    .refine((c) => c.days[0] !== c.days[1], { message: 'Дни месяца должны различаться' }),
  z.object({ kind: z.literal('quarterly'), month: z.number().int().min(1).max(3), day: Day }),
  z.object({ kind: z.literal('yearly'), month: z.number().int().min(1).max(12), day: Day })
    // 29.02 разрешено (в невисокосный год — 28.02); 30.02, 31.04 и т. п. — нет.
    .refine((c) => c.day <= daysInMonth(2024, c.month), { message: 'В этом месяце нет такого дня' }),
  z.object({ kind: z.literal('weekly'), every: z.number().int().min(1).max(12), weekday: z.number().int().min(1).max(7) }),
]);
export type Cadence = z.infer<typeof CadenceSchema>;

/** Опережение: за сколько календарных дней до плановой даты создаётся задача. Не меньше 7: этап «черновик» — за 7
 * дней, иначе задача рождалась бы с просроченным этапом (решение владельца 05.11.2026; то же — CHECK в БД и форма). */
export const LEAD_DAYS = { min: 7, max: 90, default: 10 } as const;
export const LeadDaysSchema = z.number().int().min(LEAD_DAYS.min, { message: `Опережение — не меньше ${LEAD_DAYS.min} дней: этап «черновик» начинается за 7 дней` }).max(LEAD_DAYS.max, { message: `Опережение — не больше ${LEAD_DAYS.max} дней` });
/** Этапы задачи рассылки: календарных дней до плановой даты. */
export const STAGE_OFFSETS = { draft: 7, review: 3 } as const;

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const pad = (n: number) => String(n).padStart(2, '0');
/** День месяца, которого нет (29–31 в коротком месяце), — последний день месяца. */
function clampedDate(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(Math.min(day, daysInMonth(year, month)))}`;
}

/** Номинальные даты периодичности в [from; to] (включительно), не раньше startsOn, по возрастанию. */
export function nominalDates(c: Cadence, startsOn: string, from: string, to: string): string[] {
  const lo = from > startsOn ? from : startsOn;
  if (lo > to) return [];
  const out = new Set<string>();
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
    } else if (m === c.month) days.push(c.day);
    for (const d of days) {
      const iso = clampedDate(y, m, d);
      if (iso >= lo && iso <= to) out.add(iso);
    }
  }
  return [...out].sort();
}

/** Плановая дата: номинальная или предыдущий рабочий день по производственному календарю. */
export function plannedDate(nominal: string, cal: WorkCalendar): string {
  return isoDate(onOrPrevWorkingDay(parseIsoDate(nominal), cal));
}

export interface Occurrence {
  nominal: string;
  planned: string;
}

/** Самый большой перенос назад, который учитывается при поиске номинальных дат (длинные праздники). */
const MAX_SHIFT_DAYS = 31;

/**
 * Запуски с плановой датой в окне [today; today + leadDays]. Даты раньше сегодня не возвращаются никогда — так
 * догон после простоя ограничен окном. Две номинальные даты с одной плановой дают один запуск (по первой).
 */
export function occurrencesInWindow(
  rule: { cadence: Cadence; startsOn: string; leadDays: number }, today: string, cal: WorkCalendar,
): Occurrence[] {
  const until = addDaysIso(today, rule.leadDays);
  const seen = new Set<string>();
  const out: Occurrence[] = [];
  // Плановая ≤ номинальной, поэтому номинальные раньше сегодня не дадут плановую в окне.
  for (const nominal of nominalDates(rule.cadence, rule.startsOn, today, addDaysIso(until, MAX_SHIFT_DAYS))) {
    const planned = plannedDate(nominal, cal);
    if (planned < today || planned > until || seen.has(planned)) continue;
    seen.add(planned);
    out.push({ nominal, planned });
  }
  return out;
}

/** Ближайшие count дат для предпросмотра правила: номинальная, плановая и был ли перенос. */
export function upcoming(
  rule: { cadence: Cadence; startsOn: string }, from: string, count: number, cal: WorkCalendar,
): (Occurrence & { shifted: boolean })[] {
  const out: (Occurrence & { shifted: boolean })[] = [];
  const seen = new Set<string>();
  // Окно растёт по году: «каждые 12 недель» и «ежегодно» тоже дают count дат.
  for (let horizon = 400; out.length < count && horizon <= 400 * 12; horizon += 400) {
    out.length = 0;
    seen.clear();
    for (const nominal of nominalDates(rule.cadence, rule.startsOn, from, addDaysIso(from, horizon))) {
      const planned = plannedDate(nominal, cal);
      if (planned < from || seen.has(planned)) continue;
      seen.add(planned);
      out.push({ nominal, planned, shifted: planned !== nominal });
      if (out.length === count) break;
    }
  }
  return out;
}

/** Даты этапов: черновик за 7 дней, согласование за 3 — с переносом назад, но не раньше дня создания задачи. */
export function stageDates(planned: string, createdOn: string, cal: WorkCalendar): { draftDue: string; reviewDue: string; sendDue: string } {
  const stage = (offset: number) => {
    const d = plannedDate(addDaysIso(planned, -offset), cal);
    return d < createdOn ? createdOn : d;
  };
  return { draftDue: stage(STAGE_OFFSETS.draft), reviewDue: stage(STAGE_OFFSETS.review), sendDue: planned };
}
