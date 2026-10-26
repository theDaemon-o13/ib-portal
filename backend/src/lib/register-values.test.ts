import { describe, expect, it } from 'vitest';
import {
  calcValue,
  cellPrimitive,
  displayValue,
  findUser,
  fromText,
  normalizeInput,
  parseCell,
  parseDateText,
  parseNumberText,
  typeChangeKind,
  type FieldDef,
  type UserRef,
} from './register-values.js';

const opt = (id: string, label: string, extra: Partial<{ archived: boolean; isClosed: boolean }> = {}) =>
  ({ id, label, isClosed: false, archived: false, ...extra });
const field = (type: FieldDef['type'], extra: Partial<FieldDef> = {}): FieldDef =>
  ({ id: `f-${type}`, label: type, type, options: [], calcRule: null, archived: false, ...extra });

const users: UserRef[] = [
  { id: 'u1', login: 'd.rakhimov', fullName: 'Д. Ромашов', isActive: true },
  { id: 'u2', login: 's.karimova', fullName: 'С. Калинова', isActive: true },
  { id: 'u3', login: 'a.nazarov', fullName: 'А. Незнамов', isActive: true },
  { id: 'u4', login: 'a.nazarov2', fullName: 'А. Незнамов', isActive: true },
  { id: 'u5', login: 'old.user', fullName: 'Уволен', isActive: false },
];

describe('ввод из формы', () => {
  const sel = field('select', { options: [opt('o1', 'Высокий'), opt('o2', 'Старый', { archived: true })] });
  const ctx = { assignableUsers: new Map(users.filter((u) => u.isActive).map((u) => [u.id, u])) };

  it('пустое значение очищает поле', () => {
    expect(normalizeInput(field('text'), '  ', ctx)).toEqual({ ok: true, value: null });
    expect(normalizeInput(field('number'), '', ctx)).toEqual({ ok: true, value: null });
  });

  it('проверяет тип', () => {
    expect(normalizeInput(field('number'), '12,5', ctx)).toEqual({ ok: true, value: 12.5 });
    expect(normalizeInput(field('number'), 'abc', ctx).ok).toBe(false);
    expect(normalizeInput(field('date'), '2026-02-30', ctx).ok).toBe(false);
    expect(normalizeInput(field('date'), '2026-10-26', ctx)).toEqual({ ok: true, value: '2026-10-26' });
  });

  it('список: только существующий неархивный вариант; архивный можно оставить как есть', () => {
    expect(normalizeInput(sel, 'o1', ctx)).toEqual({ ok: true, value: 'o1' });
    expect(normalizeInput(sel, 'o2', ctx).ok).toBe(false);
    expect(normalizeInput(sel, 'o2', { ...ctx, current: 'o2' })).toEqual({ ok: true, value: 'o2' });
    expect(normalizeInput(sel, 'нет', ctx).ok).toBe(false);
  });

  it('сотрудник: назначить можно активного; отключённого — только оставить', () => {
    const u = field('user');
    expect(normalizeInput(u, 'u1', ctx).ok).toBe(true);
    expect(normalizeInput(u, 'u5', ctx).ok).toBe(false);
    expect(normalizeInput(u, 'u5', { ...ctx, current: 'u5' }).ok).toBe(true);
  });

  it('вычисляемое поле и решение не принимают значений', () => {
    expect(normalizeInput(field('calc'), '2026-01-01', ctx).ok).toBe(false);
    expect(normalizeInput(field('decision'), 'o1', ctx).ok).toBe(false);
  });
});

describe('вычисляемый срок', () => {
  const rule = { fromFieldId: 'notified', byFieldId: 'crit', days: { crit: 14, high: 30 }, overrideFieldId: 'newDue' };

  it('дата + дни по значению списка', () => {
    expect(calcValue(rule, { notified: '2026-10-01', crit: 'crit' })).toBe('2026-10-15');
    expect(calcValue(rule, { notified: '2026-10-01', crit: 'high' })).toBe('2026-10-31');
  });

  it('переопределение другим полем-датой', () => {
    expect(calcValue(rule, { notified: '2026-10-01', crit: 'crit', newDue: '2027-01-15' })).toBe('2027-01-15');
  });

  it('нет даты или срока для варианта — пусто', () => {
    expect(calcValue(rule, { crit: 'crit' })).toBeNull();
    expect(calcValue(rule, { notified: '2026-10-01', crit: 'low' })).toBeNull();
  });
});

describe('смена типа поля', () => {
  it('А: поле без данных — любой тип, кроме вычисляемого и решения', () => {
    expect(typeChangeKind('text', 'user', false)).toEqual({ ok: true, value: 'empty' });
    expect(typeChangeKind('text', 'calc', false).ok).toBe(false);
    expect(typeChangeKind('decision', 'select', false).ok).toBe(false);
  });

  it('Б: число, дата, список, сотрудник → текст', () => {
    for (const from of ['number', 'date', 'select', 'user'] as const) {
      expect(typeChangeKind(from, 'text', true)).toEqual({ ok: true, value: 'to_text' });
    }
  });

  it('В: текст → число, дата, список; остальное с данными запрещено', () => {
    for (const to of ['number', 'date', 'select'] as const) expect(typeChangeKind('text', to, true)).toEqual({ ok: true, value: 'from_text' });
    expect(typeChangeKind('text', 'user', true).ok).toBe(false);
    expect(typeChangeKind('number', 'date', true).ok).toBe(false);
  });

  it('распознавание при переводе из текста', () => {
    expect(fromText('number', ' 1 200,5 ')).toBe(1200.5);
    expect(fromText('number', '12 шт')).toBeNull();
    expect(fromText('date', '30.12.2026')).toBe('2026-12-30');
    expect(fromText('date', '31.02.2026')).toBeNull();
    expect(fromText('select', ' Высокий ')).toBe('Высокий');
  });
});

describe('ячейки Excel', () => {
  const ctx = { users };

  it('значение ячейки exceljs', () => {
    expect(cellPrimitive({ richText: [{ text: 'a' }, { text: 'b' }] })).toBe('ab');
    expect(cellPrimitive({ formula: 'A1', result: 5 })).toBe(5);
    expect(cellPrimitive({ text: 'ссылка', hyperlink: 'x' })).toBe('ссылка');
    expect(cellPrimitive('   ')).toBeNull();
  });

  it('пустая ячейка не меняет значение', () => {
    expect(parseCell(field('text'), null, ctx)).toEqual({ ok: true, value: null });
    expect(parseCell(field('number'), '', ctx)).toEqual({ ok: true, value: null });
  });

  it('число и дата', () => {
    expect(parseCell(field('number'), '7,5', ctx)).toEqual({ ok: true, value: 7.5 });
    expect(parseCell(field('number'), 'семь', ctx).ok).toBe(false);
    expect(parseCell(field('date'), new Date('2026-12-30T00:00:00Z'), ctx)).toEqual({ ok: true, value: '2026-12-30' });
    expect(parseCell(field('date'), '30.12.2026', ctx)).toEqual({ ok: true, value: '2026-12-30' });
    expect(parseCell(field('date'), '2026/12/30', ctx).ok).toBe(false);
  });

  it('список — по подписи без учёта регистра, архивные варианты не принимаются', () => {
    const sel = field('select', { options: [opt('o1', 'Высокий'), opt('o2', 'Старый', { archived: true })] });
    expect(parseCell(sel, 'высокий', ctx)).toEqual({ ok: true, value: 'o1' });
    expect(parseCell(sel, 'Старый', ctx).ok).toBe(false);
    expect(parseCell(sel, 'Новый', ctx).ok).toBe(false);
  });

  it('сотрудник: по логину в скобках; по ФИО — только если имя единственное', () => {
    const u = field('user');
    expect(parseCell(u, 'Д. Ромашов (d.rakhimov)', ctx)).toEqual({ ok: true, value: 'u1' });
    expect(parseCell(u, 'Кто угодно (s.karimova)', ctx)).toEqual({ ok: true, value: 'u2' });
    expect(parseCell(u, 'С. Калинова', ctx)).toEqual({ ok: true, value: 'u2' });
    const twin = parseCell(u, 'А. Незнамов', ctx);
    expect(twin.ok).toBe(false);
    expect(!twin.ok && twin.error).toContain('несколько');
    expect(parseCell(u, 'А. Незнамов (a.nazarov2)', ctx)).toEqual({ ok: true, value: 'u4' });
    expect(parseCell(u, 'Никто (nobody)', ctx).ok).toBe(false);
    expect(parseCell(u, 'Уволен (old.user)', ctx).ok).toBe(false);
  });

  it('экспорт сотрудника — «ФИО (логин)», на экране — ФИО', () => {
    const m = new Map(users.map((x) => [x.id, x]));
    expect(displayValue(field('user'), 'u1', { users: m, userWithLogin: true })).toBe('Д. Ромашов (d.rakhimov)');
    expect(displayValue(field('user'), 'u1', { users: m })).toBe('Д. Ромашов');
    expect(findUser('Д. Ромашов (d.rakhimov)', users).ok).toBe(true);
  });

  it('разбор чисел и дат из текста', () => {
    expect(parseNumberText('-3.5e2')).toBe(-350);
    expect(parseNumberText('1,2,3')).toBeNull();
    expect(parseDateText('1.2.2026')).toBe('2026-02-01');
  });
});
