import { describe, expect, it } from 'vitest';
import { addWorkingDays, isoDate, isWorkingDay, onOrPrevWorkingDay, parseIsoDate, workingDaysBetween, type WorkCalendar } from './working-days.js';

const cal = (days: Record<string, 'holiday' | 'workday'> = {}, weekendDays = [6, 7]): WorkCalendar => ({
  weekendDays,
  days: new Map(Object.entries(days)),
});
const D = parseIsoDate;

describe('рабочие дни', () => {
  it('пятидневка: суббота и воскресенье выходные', () => {
    expect(isWorkingDay(D('2026-10-23'), cal())).toBe(true); // пятница
    expect(isWorkingDay(D('2026-10-24'), cal())).toBe(false); // суббота
    expect(isWorkingDay(D('2026-10-25'), cal())).toBe(false); // воскресенье
  });

  it('выходные дни недели настраиваются', () => {
    const sixDay = cal({}, [7]);
    expect(isWorkingDay(D('2026-10-24'), sixDay)).toBe(true);
    expect(isWorkingDay(D('2026-10-25'), sixDay)).toBe(false);
  });

  it('праздник в будни — нерабочий, перенос на субботу — рабочий', () => {
    const c = cal({ '2026-11-06': 'holiday', '2026-11-07': 'workday' });
    expect(isWorkingDay(D('2026-11-06'), c)).toBe(false);
    expect(isWorkingDay(D('2026-11-07'), c)).toBe(true);
  });

  it('3 рабочих дня с пятницы — среда; с праздником в понедельник — четверг', () => {
    expect(isoDate(addWorkingDays(D('2026-10-23'), 3, cal()))).toBe('2026-10-28');
    expect(isoDate(addWorkingDays(D('2026-10-23'), 3, cal({ '2026-10-26': 'holiday' })))).toBe('2026-10-29');
    expect(isoDate(addWorkingDays(D('2026-10-23'), 0, cal()))).toBe('2026-10-23');
  });

  it('Навруз 21–24 марта 2026 (сб–вт) сдвигает срок', () => {
    const navruz = cal({ '2026-03-21': 'holiday', '2026-03-22': 'holiday', '2026-03-23': 'holiday', '2026-03-24': 'holiday' });
    // пятница 20.03 + 1 рабочий день → среда 25.03
    expect(isoDate(addWorkingDays(D('2026-03-20'), 1, navruz))).toBe('2026-03-25');
  });

  it('10 рабочих дней для эскалации (п. 7.4)', () => {
    expect(workingDaysBetween(D('2026-10-01'), D('2026-10-15'), cal())).toBe(10);
    expect(isoDate(addWorkingDays(D('2026-10-01'), 10, cal()))).toBe('2026-10-15');
  });

  it('проверяет даты и защищается от недели без рабочих дней', () => {
    expect(() => parseIsoDate('2026-02-30')).toThrow();
    expect(() => addWorkingDays(D('2026-01-01'), 1, cal({}, [1, 2, 3, 4, 5, 6, 7]))).toThrow();
  });
});

describe('перенос на предыдущий рабочий день (1.9.0)', () => {
  it('рабочий день остаётся, суббота и воскресенье — на пятницу', () => {
    expect(isoDate(onOrPrevWorkingDay(D('2026-11-05'), cal()))).toBe('2026-11-05');
    expect(isoDate(onOrPrevWorkingDay(D('2026-11-07'), cal()))).toBe('2026-11-06');
    expect(isoDate(onOrPrevWorkingDay(D('2026-11-08'), cal()))).toBe('2026-11-06');
  });

  it('праздник и перенос рабочего дня на субботу', () => {
    expect(isoDate(onOrPrevWorkingDay(D('2026-11-06'), cal({ '2026-11-06': 'holiday' })))).toBe('2026-11-05');
    expect(isoDate(onOrPrevWorkingDay(D('2026-11-08'), cal({ '2026-11-07': 'workday' })))).toBe('2026-11-07');
  });

  it('через границу месяца: 1 марта 2026 — воскресенье → 27 февраля', () => {
    expect(isoDate(onOrPrevWorkingDay(D('2026-03-01'), cal()))).toBe('2026-02-27');
  });

  it('Навруз 21–24 марта 2026: 24.03 → пятница 20.03', () => {
    const navruz = cal({ '2026-03-21': 'holiday', '2026-03-22': 'holiday', '2026-03-23': 'holiday', '2026-03-24': 'holiday' });
    expect(isoDate(onOrPrevWorkingDay(D('2026-03-24'), navruz))).toBe('2026-03-20');
  });

  it('неделя без рабочих дней — ошибка', () => {
    expect(() => onOrPrevWorkingDay(D('2026-01-01'), cal({}, [1, 2, 3, 4, 5, 6, 7]))).toThrow();
  });
});
