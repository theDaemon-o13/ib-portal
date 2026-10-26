import { describe, expect, it } from 'vitest';
import type { RegisterDetail, RegisterRecord } from '../../api/registers';
import { changedValues, describeRule, draftOf, pinOffsets, toApiValue, typeTargets, visibleColumns } from './logic';

const field = (id: string, label: string, type: RegisterDetail['fields'][number]['type'], extra: Partial<RegisterDetail['fields'][number]> = {}) => ({
  id, label, type, sortOrder: 0, analyticsRole: null, isTitle: false, isStatus: false, calcRule: null, archived: false, version: 1, options: [], ...extra,
});
const reg: RegisterDetail = {
  id: 'r', name: 'Р', description: '', ownerUserId: null, archived: false, version: 1,
  fields: [
    field('lvl', 'Уровень', 'select', { options: [{ id: 'h', label: 'Высокий', isClosed: false, archived: false, sortOrder: 1, version: 1 }] }),
    field('t', 'Название', 'text', { isTitle: true }),
    field('n', 'Баллы', 'number'),
    field('d', 'Выявлено', 'date'),
    field('due', 'Срок', 'calc', { calcRule: { fromFieldId: 'd', byFieldId: 'lvl', days: { h: 14 }, overrideFieldId: null } }),
    field('old', 'Старое', 'text', { archived: true }),
  ],
};

describe('логика реестров', () => {
  it('описание правила вычисляемого поля', () => {
    expect(describeRule(reg, reg.fields[4] as RegisterDetail['fields'][number])).toBe('«Выявлено» + срок по «Уровень» (Высокий 14 дн.)');
  });

  it('безопасные смены типа', () => {
    expect(typeTargets('number')).toEqual(['text', 'date', 'select', 'user']);
    expect(typeTargets('text')).toEqual(['number', 'date', 'select', 'user']);
    expect(typeTargets('calc')).toEqual([]);
  });

  it('в PATCH уходят только изменённые неархивные поля; пустое — очистить', () => {
    const rec = { values: { t: 'А', n: 3 } } as unknown as RegisterRecord;
    const original = draftOf(reg, rec);
    expect(original).toEqual({ lvl: '', t: 'А', n: '3', d: '', old: '' });
    expect(changedValues(reg, original, { ...original, n: '3' })).toEqual({});
    expect(changedValues(reg, original, { ...original, n: '4,5', d: '2026-10-01' })).toEqual({ n: 4.5, d: '2026-10-01' });
    expect(changedValues(reg, original, { ...original, t: '' })).toEqual({ t: null });
    expect(changedValues(reg, original, { ...original, old: 'x' })).toEqual({});
    expect(toApiValue('number', 'abc')).toBe('abc');
  });

  it('колонки: заголовок первым, архивные скрыты; отступы закреплённых столбцов', () => {
    expect(visibleColumns(reg).map((f) => f.label)).toEqual(['Название', 'Уровень', 'Баллы', 'Выявлено', 'Срок']);
    expect(pinOffsets([200, 120, 90], 2)).toEqual([0, 200]);
    expect(pinOffsets([200, 120], 4)).toEqual([0, 200]);
    expect(pinOffsets([200], 0)).toEqual([]);
  });
});
