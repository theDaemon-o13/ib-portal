import { describe, expect, it } from 'vitest';
import {
  calcRuleFieldIds,
  calcValue,
  cellPrimitive,
  displayValue,
  findUser,
  fromText,
  normalizeInput,
  parseCell,
  parseDateText,
  parseNumberText,
  sameValue,
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

describe('длина текста: обычное и многострочное поле (релиз 1.1.0)', () => {
  const plain = field('text');
  const multi = field('text', { settings: { text: { multiline: true } } });
  const ctx = { assignableUsers: new Map<string, UserRef>() };
  const ictx = { users };

  it('форма: 4000 у обычного, 20 000 у многострочного; переносы строк сохраняются', () => {
    expect(normalizeInput(plain, 'а'.repeat(4000), ctx).ok).toBe(true);
    expect(normalizeInput(plain, 'а'.repeat(4001), ctx)).toEqual({ ok: false, error: 'Не длиннее 4000 символов' });
    expect(normalizeInput(multi, 'а'.repeat(20_000), ctx).ok).toBe(true);
    expect(normalizeInput(multi, 'а'.repeat(20_001), ctx)).toEqual({ ok: false, error: 'Не длиннее 20000 символов' });
    expect(normalizeInput(multi, 'строка 1\nстрока 2', ctx)).toEqual({ ok: true, value: 'строка 1\nстрока 2' });
  });

  it('импорт Excel — та же проверка, что и в форме', () => {
    expect(parseCell(plain, 'б'.repeat(4001), ictx)).toEqual({ ok: false, error: 'Не длиннее 4000 символов' });
    expect(parseCell(multi, 'б'.repeat(20_000), ictx).ok).toBe(true);
    expect(parseCell(multi, 'б'.repeat(20_001), ictx)).toEqual({ ok: false, error: 'Не длиннее 20000 символов' });
  });
});

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

describe('срок уязвимости: перенос и решение ИБ (п. 7.2, 7.3)', () => {
  const rule = {
    fromFieldId: 'notified', byFieldId: 'crit', days: { critical: 14, high: 30, medium: 90, low: 180 },
    overrideFieldId: 'newDue', overrideWhenFilledFieldId: 'measures', shiftToWorkday: true,
  };
  // 06.11.2026 (пятница) — праздник; 07–08.11 — выходные.
  const calendar = { weekendDays: [6, 7], days: new Map([['2026-11-06', 'holiday' as const]]) };

  it('14 / 30 / 90 / 180 календарных дней от передачи в ДИКТ', () => {
    const raw = { ...rule, shiftToWorkday: false };
    const at = (crit: string) => calcValue(raw, { notified: '2026-10-01', crit }, { calendar });
    expect([at('critical'), at('high'), at('medium'), at('low')]).toEqual(['2026-10-15', '2026-10-31', '2026-12-30', '2027-03-30']);
    // 31.10.2026 — суббота: с переносом срок — понедельник 02.11.
    expect(calcValue(rule, { notified: '2026-10-01', crit: 'high' }, { calendar })).toBe('2026-11-02');
  });

  it('срок в праздник переносится через праздник и выходные на ближайший рабочий день', () => {
    // 23.10 + 14 = 06.11 (праздник) → 07, 08 — выходные → 09.11 (понедельник).
    expect(calcValue(rule, { notified: '2026-10-23', crit: 'critical' }, { calendar })).toBe('2026-11-09');
    // Без переноса — ровно 14 дней.
    expect(calcValue({ ...rule, shiftToWorkday: false }, { notified: '2026-10-23', crit: 'critical' }, { calendar })).toBe('2026-11-06');
    // Рабочий перенос (суббота — рабочая) делает субботу сроком.
    const moved = { weekendDays: [6, 7], days: new Map([['2026-11-06', 'holiday' as const], ['2026-11-07', 'workday' as const]]) };
    expect(calcValue(rule, { notified: '2026-10-23', crit: 'critical' }, { calendar: moved })).toBe('2026-11-07');
  });

  it('п. 7.3: срок ИБ — только при заполненных компенсирующих мерах', () => {
    const base = { notified: '2026-10-01', crit: 'critical' };
    expect(calcValue(rule, { ...base, newDue: '2027-02-01' }, { calendar })).toBe('2026-10-15');
    expect(calcValue(rule, { ...base, measures: 'Сегмент изолирован', newDue: '2027-02-01' }, { calendar })).toBe('2027-02-01');
    expect(calcValue(rule, { ...base, measures: '   ', newDue: '2027-02-01' }, { calendar })).toBe('2026-10-15');
    // Явная дата решения ИБ не переносится, даже если это выходной.
    expect(calcValue(rule, { ...base, measures: 'Есть', newDue: '2026-11-07' }, { calendar })).toBe('2026-11-07');
  });

  // Релиз 1.5.0 (ADR-0030): итог = п. 7.3 ?? перенос((срок из прежнего реестра ?? передача ИКТ + дни) + продления).
  const full = { ...rule, baseFieldId: 'legacyDue', addDaysFieldId: 'extDays' };
  it('до передачи ИКТ срока нет; после — база по Критичности', () => {
    expect(calcValue(full, { crit: 'critical' }, { calendar })).toBeNull();
    expect(calcValue(full, { notified: '2026-10-01', crit: 'critical' }, { calendar })).toBe('2026-10-15');
  });

  it('продления прибавляются к базе, перенос — на итог', () => {
    // 15.10 + 22 = 06.11 (праздник) → 09.11; ноль и не целое не прибавляются.
    expect(calcValue(full, { notified: '2026-10-01', crit: 'critical', extDays: 22 }, { calendar })).toBe('2026-11-09');
    expect(calcValue(full, { notified: '2026-10-01', crit: 'critical', extDays: 0 }, { calendar })).toBe('2026-10-15');
    expect(calcValue(full, { notified: '2026-10-01', crit: 'critical', extDays: 1.5 }, { calendar })).toBe('2026-10-15');
    // Ручная Критичность пересчитывает базу, продление остаётся.
    expect(calcValue(full, { notified: '2026-10-01', crit: 'high', extDays: 14 }, { calendar })).toBe('2026-11-16');
  });

  it('срок из прежнего реестра — база вместо «передача + дни»: Критичность её не меняет, продления прибавляются', () => {
    const legacy = { notified: '2026-10-01', crit: 'critical', legacyDue: '2026-12-01' };
    expect(calcValue(full, legacy, { calendar })).toBe('2026-12-01');
    expect(calcValue(full, { ...legacy, crit: 'low' }, { calendar })).toBe('2026-12-01');
    expect(calcValue(full, { ...legacy, extDays: 30 }, { calendar })).toBe('2026-12-31');
    // Без передачи ИКТ — тоже по сроку из прежнего реестра.
    expect(calcValue(full, { crit: 'critical', legacyDue: '2026-12-01' }, { calendar })).toBe('2026-12-01');
  });

  it('п. 7.3 главнее продлений и срока из прежнего реестра', () => {
    expect(calcValue(full, { notified: '2026-10-01', crit: 'critical', extDays: 60, legacyDue: '2026-12-01', measures: 'Меры', newDue: '2026-11-20' }, { calendar }))
      .toBe('2026-11-20');
  });

  it('правило срока ссылается на поля базы и продлений (зависимости поля)', () => {
    expect(calcRuleFieldIds(full)).toEqual(['notified', 'crit', 'newDue', 'measures', 'legacyDue', 'extDays']);
  });

  it('оценка — вычисляемое поле по системным ключам значений', () => {
    const fields = [
      { id: 'exploit', label: 'Эксплойт', type: 'select' as const, calcRule: null, archived: false,
        options: [{ id: 'e1', label: 'Есть, эксплуатируется', isClosed: false, archived: false, systemKey: 'exploited' }] },
      { id: 'fix', label: 'Исправление', type: 'select' as const, calcRule: null, archived: false,
        options: [{ id: 'f1', label: 'Выпущено', isClosed: false, archived: false, systemKey: 'released' }] },
    ];
    const score = { kind: 'vuln_score' as const, cvssFieldId: 'cvss', exploitFieldId: 'exploit', fixFieldId: 'fix' };
    expect(calcValue(score, { cvss: 8.6, exploit: 'e1', fix: 'f1' }, { fields })).toBe(8.2);
    expect(calcValue(score, { exploit: 'e1' }, { fields })).toBeNull();
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

describe('поле «Значение справочника» (этап 5)', () => {
  const sys = field('catalog', { options: [opt('abs', 'АБС'), opt('old', 'Старая', { archived: true })] });

  it('ввод, отображение и Excel — по значениям справочника, архивное новым не выбрать', () => {
    expect(normalizeInput(sys, 'abs', { assignableUsers: new Map(), current: undefined })).toEqual({ ok: true, value: 'abs' });
    expect(normalizeInput(sys, 'old', { assignableUsers: new Map(), current: undefined }).ok).toBe(false);
    expect(normalizeInput(sys, 'old', { assignableUsers: new Map(), current: 'old' })).toEqual({ ok: true, value: 'old' });
    expect(displayValue(sys, 'abs', { users: new Map() })).toBe('АБС');
    expect(parseCell(sys, ' абс ', { users })).toEqual({ ok: true, value: 'abs' });
    expect(parseCell(sys, 'Нет такой', { users })).toEqual({ ok: false, error: '«Нет такой» — нет такого значения в справочнике «catalog»' });
  });

  it('смена типа: только «в текст»; в справочник ничего не превращается', () => {
    expect(typeChangeKind('catalog', 'text', true)).toEqual({ ok: true, value: 'to_text' });
    expect(typeChangeKind('catalog', 'select', false).ok).toBe(false);
    expect(typeChangeKind('text', 'catalog', false).ok).toBe(false);
    expect(typeChangeKind('select', 'catalog', true).ok).toBe(false);
  });
});

describe('поле «Связь с записью» (этап 8б)', () => {
  const link = { id: 'l', label: 'Устройства', type: 'link' as const, options: [], calcRule: null, archived: false };
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';

  it('ввод: массив id, без повторов; пустой — очистить', () => {
    expect(normalizeInput(link, [A, A, B], { assignableUsers: new Map() })).toEqual({ ok: true, value: [A, B] });
    expect(normalizeInput(link, [], { assignableUsers: new Map() })).toEqual({ ok: true, value: null });
    expect(normalizeInput(link, ['x'], { assignableUsers: new Map() }).ok).toBe(false);
  });

  it('сравнение без учёта порядка; отображение — подписи записей', () => {
    expect(sameValue([A, B], [B, A])).toBe(true);
    expect(sameValue([A], [A, B])).toBe(false);
    expect(sameValue([], null)).toBe(true);
    expect(displayValue(link, [A, B], { users: new Map(), links: new Map([[A, '#1 WS-1']]) })).toBe('#1 WS-1; (запись удалена)');
  });

  it('ячейка Excel: по ключу, «#номер», неоднозначно и не найдено', () => {
    const targets = new Map([['l', new Map([['ws-1', [A]], ['#2', [B]], ['двойник', [A, B]]])]]);
    expect(parseCell(link, 'WS-1; #2', { users: [], linkTargets: targets })).toEqual({ ok: true, value: [A, B] });
    expect(parseCell(link, 'двойник', { users: [], linkTargets: targets }).ok).toBe(false);
    expect(parseCell(link, 'нет', { users: [], linkTargets: targets })).toEqual({ ok: false, error: '«нет» — не найдено в связанном реестре' });
  });

  it('файл и связь не меняют тип', () => {
    expect(typeChangeKind('file', 'text', false).ok).toBe(false);
    expect(typeChangeKind('text', 'link', false).ok).toBe(false);
  });
});
