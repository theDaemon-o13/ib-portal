// Логика «Осведомлённости» без БД (релиз 1.8.0, docs/specs/awareness.md). Люди вымышленные.
import { describe, expect, it } from 'vitest';
import { DEFAULT_GRADES, GradesSchema } from './grades.js';
import {
  attemptKey, gradeOf, joinFio, needsRetake, normalizeFio, parseNumberCell, parseSpent, parseTestDate, pickBestOfDay, splitFio,
} from './logic.js';

describe('нормализация ФИО', () => {
  it('без регистра, лишних пробелов и «ё»', () => {
    expect(normalizeFio('  Семёнов   Пётр Ильич ')).toBe('семенов петр ильич');
    expect(normalizeFio('СЕМЕНОВ ПЕТР ИЛЬИЧ')).toBe(normalizeFio('Семёнов Пётр Ильич'));
  });
  it('пустая строка', () => {
    expect(normalizeFio('   ')).toBe('');
  });
});

describe('деление ФИО из HR (раздел 2.2)', () => {
  it('три части — фамилия, имя, отчество', () => {
    expect(splitFio(' Иванов  Иван Иванович ')).toEqual({ lastName: 'Иванов', firstName: 'Иван', middleName: 'Иванович' });
  });
  it('двойная фамилия через дефис — одна часть', () => {
    expect(splitFio('Петрова-Сидорова Анна Сергеевна')).toEqual({ lastName: 'Петрова-Сидорова', firstName: 'Анна', middleName: 'Сергеевна' });
  });
  it('четыре части с «оглы», «кызы», «угли», «кизи», «зода» — отчество из двух слов, без регистра', () => {
    for (const suffix of ['оглы', 'Кызы', 'угли', 'КИЗИ', 'зода']) {
      expect(splitFio(`Алиев Рустам Тестович ${suffix}`)).toEqual({ lastName: 'Алиев', firstName: 'Рустам', middleName: `Тестович ${suffix}` });
    }
  });
  it('иначе не делится: две части, составная фамилия, лишние слова', () => {
    expect(splitFio('Иванов Иван')).toBeNull();
    expect(splitFio('Ван Дер Тест Иван Петрович')).toBeNull();
    expect(splitFio('Иванов Иван Иванович младший')).toBeNull();
    expect(splitFio('')).toBeNull();
  });
  it('обратный случай: ФИО из частей через пробел, пустые части пропускаются', () => {
    expect(joinFio({ lastName: ' Иванов ', firstName: 'Иван', middleName: 'Иванович' })).toBe('Иванов Иван Иванович');
    expect(joinFio({ lastName: 'Иванов', firstName: 'Иван', middleName: '' })).toBe('Иванов Иван');
  });
});

describe('ключ попытки (раздел 3.1)', () => {
  it('тест как есть, нормализованное ФИО, дата', () => {
    expect(attemptKey(' Тест  по ИБ | IB test ', 'Семёнов  Пётр Ильич', '2026-10-01')).toBe('Тест по ИБ | IB test | семенов петр ильич | 2026-10-01');
  });
  it('«Семёнов» и «Семенов» — один ключ; другой день — другой', () => {
    expect(attemptKey('Т', 'Семёнов П И', '2026-10-01')).toBe(attemptKey('Т', 'семенов п и', '2026-10-01'));
    expect(attemptKey('Т', 'Семёнов П И', '2026-10-01')).not.toBe(attemptKey('Т', 'Семёнов П И', '2026-10-02'));
  });
});

describe('оценка по порогам (раздел 3.2)', () => {
  const g = DEFAULT_GRADES;
  it('границы: 90 — «Отлично», 89,9 — «Хорошо», без округления', () => {
    expect(gradeOf(90, g)).toBe('excellent');
    expect(gradeOf(89.9, g)).toBe('good');
    expect(gradeOf(70, g)).toBe('good');
    expect(gradeOf(69.9, g)).toBe('satisfactory');
    expect(gradeOf(50, g)).toBe('satisfactory');
    expect(gradeOf(49.9, g)).toBe('fail');
    expect(gradeOf(0, g)).toBe('fail');
  });
  it('пересдача — отдельный порог, не связан с оценкой', () => {
    const own = { ...g, retakeBelow: 75 };
    expect(needsRetake(74.9, own)).toBe(true);
    expect(needsRetake(75, own)).toBe(false);
    expect(gradeOf(74.9, own)).toBe('good');
    expect(needsRetake(49.9, g)).toBe(true);
    expect(needsRetake(50, g)).toBe(false);
  });
  it('пороги из настроек, а не зашитые', () => {
    expect(gradeOf(85, { excellent: 80, good: 60, satisfactory: 40, retakeBelow: 40 })).toBe('excellent');
  });
});

describe('проверка порогов', () => {
  it('значения по умолчанию проходят', () => {
    expect(GradesSchema.safeParse(DEFAULT_GRADES).success).toBe(true);
    expect(GradesSchema.safeParse({ excellent: 100, good: 70.5, satisfactory: 0, retakeBelow: 100 }).success).toBe(true);
  });
  it('по убыванию: excellent > good > satisfactory', () => {
    expect(GradesSchema.safeParse({ ...DEFAULT_GRADES, good: 90 }).success).toBe(false);
    expect(GradesSchema.safeParse({ ...DEFAULT_GRADES, satisfactory: 70 }).success).toBe(false);
  });
  it('0–100, не больше одного знака после запятой, без лишних ключей, числа', () => {
    expect(GradesSchema.safeParse({ ...DEFAULT_GRADES, excellent: 101 }).success).toBe(false);
    expect(GradesSchema.safeParse({ ...DEFAULT_GRADES, retakeBelow: -1 }).success).toBe(false);
    expect(GradesSchema.safeParse({ ...DEFAULT_GRADES, good: 70.25 }).success).toBe(false);
    expect(GradesSchema.safeParse({ ...DEFAULT_GRADES, extra: 1 }).success).toBe(false);
    expect(GradesSchema.safeParse({ ...DEFAULT_GRADES, good: '70' }).success).toBe(false);
    expect(GradesSchema.safeParse({ excellent: 90 }).success).toBe(false);
  });
});

describe('дата теста (раздел 4.3)', () => {
  it('текст ДД.ММ.ГГГГ и ГГГГ-ММ-ДД', () => {
    expect(parseTestDate('01.10.2026')).toBe('2026-10-01');
    expect(parseTestDate(' 1.10.2026 ')).toBe('2026-10-01');
    expect(parseTestDate('2026-10-01')).toBe('2026-10-01');
  });
  it('ячейка-дата Excel (после пересохранения)', () => {
    expect(parseTestDate(new Date(Date.UTC(2026, 9, 1)))).toBe('2026-10-01');
  });
  it('несуществующая дата и мусор — null (ошибка строки)', () => {
    expect(parseTestDate('31.02.2026')).toBeNull();
    expect(parseTestDate('вчера')).toBeNull();
    expect(parseTestDate('')).toBeNull();
    expect(parseTestDate(null)).toBeNull();
    expect(parseTestDate(46000)).toBeNull();
    expect(parseTestDate(new Date(Number.NaN))).toBeNull();
  });
});

describe('затраченное время (раздел 4.3)', () => {
  it('текст ЧЧ:ММ:СС — как есть', () => {
    expect(parseSpent('00:12:34')).toEqual({ text: '00:12:34', warning: false });
    expect(parseSpent('1:02:03')).toEqual({ text: '1:02:03', warning: false });
  });
  it('доля суток — в ЧЧ:ММ:СС', () => {
    expect(parseSpent(754 / 86_400)).toEqual({ text: '00:12:34', warning: false });
    expect(parseSpent(1.5)).toEqual({ text: '36:00:00', warning: false });
  });
  it('ячейка-время Excel (дата от 30.12.1899) — в ЧЧ:ММ:СС', () => {
    expect(parseSpent(new Date(Date.UTC(1899, 11, 30, 0, 12, 34)))).toEqual({ text: '00:12:34', warning: false });
  });
  it('другое — текстом с предупреждением; пусто — без значения', () => {
    expect(parseSpent('12 мин')).toEqual({ text: '12 мин', warning: true });
    expect(parseSpent('00:75:00')).toEqual({ text: '00:75:00', warning: true });
    expect(parseSpent(new Date(Date.UTC(2026, 9, 1)))).toMatchObject({ warning: true });
    expect(parseSpent(-1)).toMatchObject({ warning: true });
    expect(parseSpent(null)).toEqual({ text: null, warning: false });
    expect(parseSpent('  ')).toEqual({ text: null, warning: false });
  });
});

describe('числа отчёта', () => {
  it('число, запятая или точка, знак «%»', () => {
    expect(parseNumberCell(74.3)).toBe(74.3);
    expect(parseNumberCell('74,3')).toBe(74.3);
    expect(parseNumberCell(' 74.3 % ')).toBe(74.3);
    expect(parseNumberCell('нет')).toBeNull();
    expect(parseNumberCell(null)).toBeNull();
    expect(parseNumberCell(Number.NaN)).toBeNull();
  });
});

describe('повторы в один день (решение 3)', () => {
  const row = (key: string, percent: number, n: number) => ({ key, percent, n });
  it('остаётся попытка с большим процентом, остальные — повторы; порядок как в файле', () => {
    const rows = [row('a', 40, 1), row('b', 90, 2), row('A', 60, 3), row('a', 50, 4)];
    const { kept, repeats } = pickBestOfDay(rows);
    expect(kept.map((r) => r.n)).toEqual([2, 3]);
    expect(repeats.map((r) => r.n)).toEqual([1, 4]);
  });
  it('при равном проценте — первая по порядку', () => {
    const { kept, repeats } = pickBestOfDay([row('a', 70, 1), row('a', 70, 2)]);
    expect(kept.map((r) => r.n)).toEqual([1]);
    expect(repeats.map((r) => r.n)).toEqual([2]);
  });
  it('без повторов — всё остаётся', () => {
    expect(pickBestOfDay([row('a', 1, 1), row('b', 2, 2)]).repeats).toEqual([]);
  });
});
