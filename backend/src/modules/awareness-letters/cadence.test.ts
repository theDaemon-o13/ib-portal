import { describe, expect, it } from 'vitest';
import { todayIso } from '../../lib/today.js';
import type { WorkCalendar } from '../../lib/working-days.js';
import { CadenceSchema, nominalDates, occurrencesInWindow, plannedDate, stageDates, upcoming, type Cadence } from './cadence.js';

const cal = (days: Record<string, 'holiday' | 'workday'> = {}): WorkCalendar => ({ weekendDays: [6, 7], days: new Map(Object.entries(days)) });
const START = '2026-01-01';

describe('номинальные даты', () => {
  it('ежемесячно в день N; 31-е в 30-дневном месяце и в феврале — последний день', () => {
    expect(nominalDates({ kind: 'monthly', day: 15 }, START, '2026-01-01', '2026-03-31')).toEqual(['2026-01-15', '2026-02-15', '2026-03-15']);
    expect(nominalDates({ kind: 'monthly', day: 31 }, START, '2026-01-01', '2026-04-30'))
      .toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    expect(nominalDates({ kind: 'monthly', day: 29 }, START, '2028-02-01', '2028-02-29')).toEqual(['2028-02-29']);
  });

  it('дважды в месяц в дни N и M (порядок не важен)', () => {
    expect(nominalDates({ kind: 'twice_monthly', days: [20, 5] }, START, '2026-02-01', '2026-03-10'))
      .toEqual(['2026-02-05', '2026-02-20', '2026-03-05']);
    // 30 и 31 в феврале дают одну дату — последний день.
    expect(nominalDates({ kind: 'twice_monthly', days: [30, 31] }, START, '2026-02-01', '2026-02-28')).toEqual(['2026-02-28']);
  });

  it('ежеквартально: день N первого, второго или третьего месяца квартала', () => {
    expect(nominalDates({ kind: 'quarterly', month: 1, day: 10 }, START, '2026-01-01', '2026-12-31'))
      .toEqual(['2026-01-10', '2026-04-10', '2026-07-10', '2026-10-10']);
    expect(nominalDates({ kind: 'quarterly', month: 2, day: 31 }, START, '2026-01-01', '2026-12-31'))
      .toEqual(['2026-02-28', '2026-05-31', '2026-08-31', '2026-11-30']);
    expect(nominalDates({ kind: 'quarterly', month: 3, day: 1 }, START, '2026-01-01', '2026-06-30')).toEqual(['2026-03-01', '2026-06-01']);
  });

  it('ежегодно D.M; 29.02 в невисокосный год — 28.02', () => {
    expect(nominalDates({ kind: 'yearly', month: 9, day: 1 }, START, '2026-01-01', '2027-12-31')).toEqual(['2026-09-01', '2027-09-01']);
    expect(nominalDates({ kind: 'yearly', month: 2, day: 29 }, START, '2026-01-01', '2028-12-31')).toEqual(['2026-02-28', '2027-02-28', '2028-02-29']);
  });

  it('каждую N-ю неделю: первый такой день недели не раньше даты начала, затем шаг', () => {
    // 01.01.2026 — четверг; вторник (2) — 06.01, затем каждые 2 недели.
    const c: Cadence = { kind: 'weekly', every: 2, weekday: 2 };
    expect(nominalDates(c, START, '2026-01-01', '2026-02-10')).toEqual(['2026-01-06', '2026-01-20', '2026-02-03']);
    // Окно с середины: шаг сохраняется от даты начала.
    expect(nominalDates(c, START, '2026-01-21', '2026-02-17')).toEqual(['2026-02-03', '2026-02-17']);
    // День начала — тот же день недели: он первая дата.
    expect(nominalDates({ kind: 'weekly', every: 1, weekday: 4 }, START, START, '2026-01-15')).toEqual(['2026-01-01', '2026-01-08', '2026-01-15']);
  });

  it('не раньше даты начала', () => {
    expect(nominalDates({ kind: 'monthly', day: 1 }, '2026-03-15', '2026-01-01', '2026-05-31')).toEqual(['2026-04-01', '2026-05-01']);
  });
});

describe('плановая дата и окно', () => {
  it('выходной и праздник — на предыдущий рабочий день, в том числе в прошлый месяц', () => {
    expect(plannedDate('2026-11-07', cal())).toBe('2026-11-06'); // суббота
    expect(plannedDate('2026-03-01', cal())).toBe('2026-02-27'); // воскресенье → пятница февраля
    expect(plannedDate('2026-09-09', cal({ '2026-09-09': 'holiday' }))).toBe('2026-09-08');
  });

  it('окно [сегодня; сегодня + опережение]: в окне — да, раньше сегодня — никогда', () => {
    const rule = { cadence: { kind: 'monthly', day: 15 } as Cadence, startsOn: START, leadDays: 10 };
    expect(occurrencesInWindow(rule, '2026-12-04', cal())).toEqual([]);
    expect(occurrencesInWindow(rule, '2026-12-05', cal())).toEqual([{ nominal: '2026-12-15', planned: '2026-12-15' }]);
    // Догон после простоя: 15.12 ещё в окне 14.12 — создаётся; 16.12 — уже прошла, не создаётся.
    expect(occurrencesInWindow(rule, '2026-12-14', cal())).toHaveLength(1);
    expect(occurrencesInWindow(rule, '2026-12-16', cal())).toEqual([]);
  });

  it('перенос назад вводит дату в окно: 15.11.2026 (вс) → 13.11 попадает в окно 03.11 при опережении 10', () => {
    const rule = { cadence: { kind: 'monthly', day: 15 } as Cadence, startsOn: START, leadDays: 10 };
    expect(occurrencesInWindow(rule, '2026-11-03', cal())).toEqual([{ nominal: '2026-11-15', planned: '2026-11-13' }]);
  });

  it('две номинальные даты на одну плановую — один запуск (по первой номинальной)', () => {
    // 07.11 (сб) и 08.11 (вс) обе переносятся на пятницу 06.11.
    const rule = { cadence: { kind: 'twice_monthly', days: [7, 8] } as Cadence, startsOn: START, leadDays: 10 };
    expect(occurrencesInWindow(rule, '2026-11-01', cal())).toEqual([{ nominal: '2026-11-07', planned: '2026-11-06' }]);
  });

  it('граница суток по местному времени портала (+05), не по UTC', () => {
    const rule = { cadence: { kind: 'monthly', day: 10 } as Cadence, startsOn: START, leadDays: 10 };
    // 30.11 18:59 UTC — ещё 30.11 в Душанбе: 10.12 в окне; 30.11 19:00 UTC — уже 01.12.
    const before = todayIso(new Date('2026-11-30T18:59:59Z'), 'Asia/Dushanbe');
    const after = todayIso(new Date('2026-11-30T19:00:00Z'), 'Asia/Dushanbe');
    expect([before, after]).toEqual(['2026-11-30', '2026-12-01']);
    expect(occurrencesInWindow(rule, before, cal())).toEqual([{ nominal: '2026-12-10', planned: '2026-12-10' }]);
    // По UTC было бы 30.11 и в 19:00 — проверяем, что окно сдвигается вместе с местной датой.
    expect(occurrencesInWindow({ ...rule, leadDays: 9 }, before, cal())).toEqual([]);
    expect(occurrencesInWindow({ ...rule, leadDays: 9 }, after, cal())).toEqual([{ nominal: '2026-12-10', planned: '2026-12-10' }]);
  });
});

describe('этапы и предпросмотр', () => {
  it('черновик за 7 дней, согласование за 3, с переносом назад', () => {
    // Плановая 16.11.2026 (пн): −7 = 09.11 (пн), −3 = 13.11 (пт).
    expect(stageDates('2026-11-16', '2026-11-01', cal())).toEqual({ draftDue: '2026-11-09', reviewDue: '2026-11-13', sendDue: '2026-11-16' });
    // Плановая 18.11 (ср): −3 = 15.11 (вс) → 13.11 (пт).
    expect(stageDates('2026-11-18', '2026-11-01', cal()).reviewDue).toBe('2026-11-13');
  });

  it('этап не раньше дня создания задачи (короткое опережение, догон)', () => {
    expect(stageDates('2026-11-16', '2026-11-12', cal())).toEqual({ draftDue: '2026-11-12', reviewDue: '2026-11-13', sendDue: '2026-11-16' });
  });

  it('ближайшие даты с отметкой переноса; ежегодное правило даёт нужное число дат', () => {
    const u = upcoming({ cadence: { kind: 'monthly', day: 7 }, startsOn: START }, '2026-11-01', 2, cal());
    expect(u).toEqual([
      { nominal: '2026-11-07', planned: '2026-11-06', shifted: true },
      { nominal: '2026-12-07', planned: '2026-12-07', shifted: false },
    ]);
    expect(upcoming({ cadence: { kind: 'yearly', month: 9, day: 1 }, startsOn: START }, '2026-11-01', 6, cal())).toHaveLength(6);
  });
});

describe('проверка параметров', () => {
  it('принимает допустимые и отклоняет неверные', () => {
    expect(CadenceSchema.safeParse({ kind: 'monthly', day: 31 }).success).toBe(true);
    expect(CadenceSchema.safeParse({ kind: 'monthly', day: 0 }).success).toBe(false);
    expect(CadenceSchema.safeParse({ kind: 'twice_monthly', days: [5, 5] }).success).toBe(false);
    expect(CadenceSchema.safeParse({ kind: 'quarterly', month: 4, day: 1 }).success).toBe(false);
    expect(CadenceSchema.safeParse({ kind: 'yearly', month: 2, day: 29 }).success).toBe(true);
    expect(CadenceSchema.safeParse({ kind: 'yearly', month: 2, day: 30 }).success).toBe(false);
    expect(CadenceSchema.safeParse({ kind: 'yearly', month: 4, day: 31 }).success).toBe(false);
    expect(CadenceSchema.safeParse({ kind: 'weekly', every: 13, weekday: 1 }).success).toBe(false);
    expect(CadenceSchema.safeParse({ kind: 'weekly', every: 2, weekday: 8 }).success).toBe(false);
  });
});
