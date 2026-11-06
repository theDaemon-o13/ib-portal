import { describe, expect, it } from 'vitest';
import { nominalDates, plannedDate } from './cadence.js';
import { runDate, taskDue, nextRun } from '../modules/documents/automations.js';
import { todayIso } from './today.js';
import type { WorkCalendar } from './working-days.js';

/** Пятидневка без праздников и с одним праздником (вторник 03.02.2026). */
const plain: WorkCalendar = { weekendDays: [6, 7], days: new Map() };
const withHoliday: WorkCalendar = { weekendDays: [6, 7], days: new Map([['2026-02-03', 'holiday']]) };

describe('lib/cadence: номинальные даты (1.11.0, ADR-0041)', () => {
  it('ежедневно, еженедельно, ежемесячно, ежеквартально, раз в полгода, ежегодно', () => {
    expect(nominalDates({ kind: 'daily' }, '2026-02-26', '2026-02-26', '2026-03-02')).toEqual(['2026-02-26', '2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
    expect(nominalDates({ kind: 'weekly', every: 1, weekday: 1 }, '2026-01-01', '2026-01-01', '2026-01-20')).toEqual(['2026-01-05', '2026-01-12', '2026-01-19']);
    expect(nominalDates({ kind: 'monthly', day: 15 }, '2026-01-01', '2026-01-01', '2026-03-31')).toEqual(['2026-01-15', '2026-02-15', '2026-03-15']);
    expect(nominalDates({ kind: 'quarterly', month: 2, day: 10 }, '2026-01-01', '2026-01-01', '2026-12-31')).toEqual(['2026-02-10', '2026-05-10', '2026-08-10', '2026-11-10']);
    expect(nominalDates({ kind: 'semiannual', month: 3, day: 1 }, '2026-01-01', '2026-01-01', '2027-12-31')).toEqual(['2026-03-01', '2026-09-01', '2027-03-01', '2027-09-01']);
    expect(nominalDates({ kind: 'yearly', month: 11, day: 5 }, '2026-01-01', '2026-01-01', '2028-12-31')).toEqual(['2026-11-05', '2027-11-05', '2028-11-05']);
  });
  it('31-е в коротком месяце — последний день; 29.02 в невисокосный год — 28.02; не раньше даты начала', () => {
    expect(nominalDates({ kind: 'monthly', day: 31 }, '2026-01-01', '2026-01-01', '2026-04-30')).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    expect(nominalDates({ kind: 'yearly', month: 2, day: 29 }, '2026-01-01', '2026-01-01', '2028-12-31')).toEqual(['2026-02-28', '2027-02-28', '2028-02-29']);
    expect(nominalDates({ kind: 'semiannual', month: 2, day: 31 }, '2026-03-01', '2026-01-01', '2026-12-31')).toEqual(['2026-08-31']);
  });
});

describe('автоматизации контроля: перенос и срок задачи (решение владельца 7)', () => {
  it('срок в рабочих днях — запуск с выходного на предыдущий рабочий день, не раньше первого запуска; в календарных — без переноса', () => {
    // 01.02.2026 — воскресенье.
    expect(plannedDate('2026-02-01', plain)).toBe('2026-01-30');
    expect(plannedDate('2026-02-01', plain, 'none')).toBe('2026-02-01');
    expect(runDate({ dueKind: 'working', startsOn: '2026-01-01' }, '2026-02-01', plain)).toBe('2026-01-30');
    expect(runDate({ dueKind: 'calendar', startsOn: '2026-01-01' }, '2026-02-01', plain)).toBe('2026-02-01');
    // Первый запуск — в воскресенье 01.02: перенос не раньше даты первого запуска.
    expect(runDate({ dueKind: 'working', startsOn: '2026-02-01' }, '2026-02-01', plain)).toBe('2026-02-01');
  });
  it('срок — от фактического дня создания: + X рабочих (через праздник) или + X календарных', () => {
    expect(taskDue({ dueKind: 'working', dueDays: 3 }, '2026-01-30', plain)).toBe('2026-02-04');
    expect(taskDue({ dueKind: 'working', dueDays: 3 }, '2026-01-30', withHoliday)).toBe('2026-02-05');
    expect(taskDue({ dueKind: 'calendar', dueDays: 3 }, '2026-01-30', withHoliday)).toBe('2026-02-02');
  });
  it('ближайший запуск — с учётом переноса', () => {
    expect(nextRun({ cadence: { kind: 'monthly', day: 1 }, startsOn: '2026-01-01', dueKind: 'working' }, '2026-01-30', plain)).toEqual({ nominal: '2026-02-01', planned: '2026-01-30' });
    expect(nextRun({ cadence: { kind: 'monthly', day: 1 }, startsOn: '2026-01-01', dueKind: 'working' }, '2026-01-31', plain)).toEqual({ nominal: '2026-03-01', planned: '2026-02-27' });
  });
  it('граница суток — по часовому поясу портала (APP_TZ = Asia/Dushanbe, UTC+5)', () => {
    expect(todayIso(new Date('2026-01-29T18:59:00Z'))).toBe('2026-01-29');
    expect(todayIso(new Date('2026-01-29T19:00:00Z'))).toBe('2026-01-30');
  });
});
