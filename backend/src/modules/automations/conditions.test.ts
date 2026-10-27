import { describe, expect, it } from 'vitest';
import type { Values } from '../../lib/register-values.js';
import type { WorkCalendar } from '../../lib/working-days.js';
import { evaluate, type Condition } from './conditions.js';

// 06.11.2026 (пятница) — праздник.
const calendar: WorkCalendar = { weekendDays: [6, 7], days: new Map([['2026-11-06', 'holiday']]) };
const rec = (values: Values, due: string | null) => ({ values, dateOf: (id: string) => (id === 'due' ? due : null) });

describe('условие «за N дней до даты»', () => {
  const c: Condition = { kind: 'before', fieldId: 'due', days: 3 };

  it('срабатывает с даты − N по саму дату включительно', () => {
    expect(evaluate(c, rec({}, '2026-11-10'), '2026-11-06', calendar)).toBeNull(); // за 4 дня
    expect(evaluate(c, rec({}, '2026-11-10'), '2026-11-07', calendar)).toEqual({ triggerKey: '2026-11-10' }); // за 3
    expect(evaluate(c, rec({}, '2026-11-10'), '2026-11-10', calendar)).toEqual({ triggerKey: '2026-11-10' });
  });

  it('уже просроченное и запись без даты — не его дело', () => {
    expect(evaluate(c, rec({}, '2026-11-10'), '2026-11-11', calendar)).toBeNull();
    expect(evaluate(c, rec({}, null), '2026-11-10', calendar)).toBeNull();
  });
});

describe('условие «дата просрочена» (п. 7.4)', () => {
  const c: Condition = { kind: 'overdue', fieldId: 'due' };

  it('в день срока ещё не просрочено, на следующий — просрочено', () => {
    expect(evaluate(c, rec({}, '2026-11-03'), '2026-11-03', calendar)).toBeNull();
    expect(evaluate(c, rec({}, '2026-11-03'), '2026-11-04', calendar)).toEqual({ triggerKey: '2026-11-03' });
  });

  it('ключ — дата срока: перенос срока даёт новое событие', () => {
    expect(evaluate(c, rec({}, '2026-11-03'), '2026-12-01', calendar)?.triggerKey).toBe('2026-11-03');
    expect(evaluate(c, rec({}, '2026-11-20'), '2026-12-01', calendar)?.triggerKey).toBe('2026-11-20');
  });
});

describe('эскалация: нет мер 10 рабочих дней после просрочки (п. 7.4)', () => {
  const c: Condition = { kind: 'overdue', fieldId: 'due', workdays: 10, unlessFilledFieldId: 'measures' };
  // Срок 03.11 (вторник). Рабочие дни после: 04, 05, [06 праздник, 07–08 выходные], 09, 10, 11, 12, 13, 16, 17 (9-й), 18 (10-й).

  it('через выходные и праздник: 9 рабочих дней — нет, 10 — есть', () => {
    expect(evaluate(c, rec({}, '2026-11-03'), '2026-11-17', calendar)).toBeNull();
    expect(evaluate(c, rec({}, '2026-11-03'), '2026-11-18', calendar)).toEqual({ triggerKey: '2026-11-03' });
  });

  it('без праздника 10-й рабочий день наступает раньше', () => {
    const plain: WorkCalendar = { weekendDays: [6, 7], days: new Map() };
    expect(evaluate(c, rec({}, '2026-11-03'), '2026-11-17', plain)).toEqual({ triggerKey: '2026-11-03' });
  });

  it('рабочая суббота (перенос) засчитывается', () => {
    const moved: WorkCalendar = { weekendDays: [6, 7], days: new Map([['2026-11-06', 'holiday'], ['2026-11-07', 'workday']]) };
    expect(evaluate(c, rec({}, '2026-11-03'), '2026-11-17', moved)).toEqual({ triggerKey: '2026-11-03' });
  });

  it('компенсирующие меры заполнены — эскалации нет', () => {
    expect(evaluate(c, rec({ measures: 'Порт закрыт на МСЭ' }, '2026-11-03'), '2026-12-01', calendar)).toBeNull();
    expect(evaluate(c, rec({ measures: '  ' }, '2026-11-03'), '2026-12-01', calendar)).not.toBeNull();
  });
});

describe('условие «поле = значение»', () => {
  const c: Condition = { kind: 'equals', fieldId: 'status', optionId: 'work' };

  it('срабатывает по id значения', () => {
    expect(evaluate(c, rec({ status: 'work' }, null), '2026-11-01', calendar)).toEqual({ triggerKey: 'work' });
    expect(evaluate(c, rec({ status: 'open' }, null), '2026-11-01', calendar)).toBeNull();
  });
});
