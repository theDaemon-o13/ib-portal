import { describe, expect, it } from 'vitest';
import { personKey } from './logic';
import { addLabel, BATCH_MAX, buildBatch, type ManualRow } from './party-batch';

const ivanov = { id: '1', fullName: 'Иванов И.И.', position: 'Технический директор' };
const petrova = { id: '2', fullName: 'Петрова П.П.', position: 'Главный бухгалтер' };
const row = (key: string, fullName: string, department = ''): ManualRow => ({ key, fullName, department });

describe('Пачка ответственных лиц (1.13.5)', () => {
  it('сначала выбранные, затем ручные строки; пустая ручная строка не считается; пробелы схлопываются', () => {
    const b = buildBatch([ivanov, petrova], [row('a', '  Сидоров   С.С. ', 'Начальник службы'), row('b', '', '')], new Set());
    expect(b.people).toEqual([
      { fullName: 'Иванов И.И.', department: 'Технический директор' },
      { fullName: 'Петрова П.П.', department: 'Главный бухгалтер' },
      { fullName: 'Сидоров С.С.', department: 'Начальник службы' },
    ]);
    expect([b.ok, b.rowErrors, addLabel(b.people.length)]).toEqual([true, {}, 'Добавить (3)']);
  });

  it('ошибки строк: без ФИО, уже в документе, повтор выбранного из справочника — кнопка неактивна', () => {
    const taken = new Set([personKey('Сидоров С.С.', 'Начальник службы')]);
    const b = buildBatch([ivanov], [
      row('a', '', 'Юрист'),
      row('b', 'сидоров с.с.', ' начальник  службы'),
      row('c', 'иванов и.и.', 'ТЕХНИЧЕСКИЙ ДИРЕКТОР'),
      row('d', 'Иванов И.И.', 'Главный бухгалтер'),
    ], taken);
    expect(b.rowErrors).toEqual({ a: 'Укажите ФИО', b: 'Уже добавлен(а) в документ', c: 'Уже есть в списке выше' });
    // Однофамилец с другой должностью — другой человек.
    expect(b.people.map((p) => p.department)).toEqual(['Технический директор', 'Главный бухгалтер']);
    expect(b.ok).toBe(false);
  });

  it('никого — нельзя; больше лимита — нельзя', () => {
    expect(buildBatch([], [row('a', '', '')], new Set()).ok).toBe(false);
    expect(addLabel(0)).toBe('Добавить');
    const many = Array.from({ length: BATCH_MAX + 1 }, (_, i) => ({ id: String(i), fullName: `Тестов ${i}`, position: '' }));
    expect(buildBatch(many, [], new Set()).ok).toBe(false);
    expect(buildBatch(many.slice(0, BATCH_MAX), [], new Set()).ok).toBe(true);
  });

  it('почта (1.13.6): из справочника и из ручной строки — текстом, в нижнем регистре; пустая не отправляется; неверная — ошибка строки', () => {
    const b = buildBatch([{ ...ivanov, email: 'ivanov@example.com' }, petrova], [
      { key: 'a', fullName: 'Сидоров С.С.', department: 'Юрист', email: ' Sidorov@Example.com ' },
      { key: 'b', fullName: '', department: '', email: '' },
    ], new Set());
    expect(b.people).toEqual([
      { fullName: 'Иванов И.И.', department: 'Технический директор', email: 'ivanov@example.com' },
      { fullName: 'Петрова П.П.', department: 'Главный бухгалтер' },
      { fullName: 'Сидоров С.С.', department: 'Юрист', email: 'sidorov@example.com' },
    ]);
    const bad = buildBatch([], [{ key: 'a', fullName: 'Сидоров С.С.', department: '', email: 'сидоров' }], new Set());
    expect([bad.ok, bad.rowErrors]).toEqual([false, { a: 'Почта — в виде ivanov@example.com' }]);
    // Строка только с почтой — не пустая: нужна ФИО.
    expect(buildBatch([], [{ key: 'a', fullName: '', department: '', email: 'x@example.com' }], new Set()).rowErrors).toEqual({ a: 'Укажите ФИО' });
  });
});
