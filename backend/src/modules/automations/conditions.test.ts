import { describe, expect, it } from 'vitest';
import type { Values } from '../../lib/register-values.js';
import type { WorkCalendar } from '../../lib/working-days.js';
import { digestTitle, evaluate, evaluateYearly, type Condition } from './conditions.js';

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

describe('условия этапа 8б', () => {
  it('за N дней — кроме дат 31.12, если skipYearEnd', () => {
    const c: Condition = { kind: 'before', fieldId: 'due', days: 14, skipYearEnd: true };
    expect(evaluate(c, rec({}, '2026-12-31'), '2026-12-20', calendar)).toBeNull();
    expect(evaluate(c, rec({}, '2026-06-30'), '2026-06-20', calendar)).toEqual({ triggerKey: '2026-06-30' });
  });

  it('ежегодно 1 декабря: в день и догоняя неделю, ключ — дата этого года', () => {
    const c = { kind: 'yearly' as const, month: 12, day: 1 };
    expect(evaluateYearly(c, '2026-11-30')).toBeNull();
    expect(evaluateYearly(c, '2026-12-01')).toEqual({ triggerKey: '2026-12-01' });
    expect(evaluateYearly(c, '2026-12-07')).toEqual({ triggerKey: '2026-12-01' });
    expect(evaluateYearly(c, '2026-12-08')).toBeNull();
    expect(digestTitle('Продление разрешений на {год}', '2026-12-01')).toBe('Продление разрешений на 2027');
  });

  it('канал без основания: none и expired, ключ — канал и разрешение', () => {
    const c: Condition = { kind: 'basis_missing', fieldId: 'b' };
    const view = (state: string, permissionId: string | null) => ({ ...rec({}, null), basisOf: () => ({ state, permissionId, channel: 'tg' }) });
    expect(evaluate(c, view('ok', 'p'), '2026-06-01', calendar)).toBeNull();
    expect(evaluate(c, view('closed', null), '2026-06-01', calendar)).toBeNull();
    expect(evaluate(c, view('none', null), '2026-06-01', calendar)).toEqual({ triggerKey: 'tg:none:-' });
    expect(evaluate(c, view('expired', 'p'), '2026-06-01', calendar)).toEqual({ triggerKey: 'tg:expired:p' });
  });
});
